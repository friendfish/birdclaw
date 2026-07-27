import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import {
	getBirdclawConfig,
	getBirdclawPaths,
	resolveDigestArchiveDir,
	type DigestSchedulePeriod,
	type DigestScheduleTime,
} from "./config";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import {
	buildLaunchAgent,
	buildLaunchProgramArguments,
	installLaunchAgentEffect,
	resolveUserPath,
	type LaunchAgentInstallOptions,
	type LaunchAgentInstallResult,
} from "./launchd";
import {
	acquireScheduledJobLockEffect,
	appendScheduledJobAuditEffect,
	peekScheduledJobLock,
	peekScheduledJobLockEffect,
	startScheduledJobRun,
} from "./scheduled-job";
import {
	streamPeriodDigest,
	type PeriodDigestContentSource,
	type PeriodDigestContext,
	type PeriodDigestPreset,
	type PeriodDigestRunResult,
} from "./period-digest";

const DEFAULT_CONTENT_SOURCES: PeriodDigestContentSource[] = [
	"all",
	"following",
	"for_you",
];
const DEFAULT_DIGEST_ARCHIVE_RETRIES = 2;
const DEFAULT_DIGEST_ARCHIVE_RETRY_DELAY_MS = 2 * 60_000;
// Generous: 3 sources x up to (1 + retries) attempts each, plus the retry
// delay between attempts, plus actual generation time per attempt.
export const DEFAULT_LOCK_STALE_MS = 45 * 60 * 1000;

// The reviewed default: 24h was originally 08:20, moved to 08:45 to widen
// the gap from Today's 08:00 run given the ~30 minute worst-case retry
// budget (see PR discussion) — both jobs use independent lock files so they
// can genuinely overlap if Today runs long; this just makes it less likely.
const DEFAULT_DIGEST_SCHEDULE_BY_PERIOD: Record<
	PeriodDigestPreset,
	{ hour: number; minute: number; weekday?: number }
> = {
	today: { hour: 8, minute: 0 },
	"24h": { hour: 8, minute: 45 },
	yesterday: { hour: 1, minute: 0 },
	week: { hour: 2, minute: 0, weekday: 1 },
};

export interface DigestArchiveJobOptions {
	period: PeriodDigestPreset;
	account?: string;
	includeDms?: boolean;
	contentSources?: PeriodDigestContentSource[];
	archiveDir?: string;
	retries?: number;
	retryDelayMs?: number;
	logPath?: string;
	lockPath?: string;
	now?: () => Date;
}

export interface DigestArchiveStepResult {
	contentSource: PeriodDigestContentSource;
	ok: boolean;
	attempts: number;
	cached: boolean;
	updatedAt?: string;
	markdownPath?: string;
	jsonPath?: string;
	error?: string;
}

export interface DigestArchiveAuditEntry {
	job: "digest-archive";
	period: PeriodDigestPreset;
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	host: string;
	pid: number;
	runDate: string;
	options: {
		period: PeriodDigestPreset;
		account?: string;
		includeDms: boolean;
		contentSources: PeriodDigestContentSource[];
		archiveDir: string;
		retries: number;
		retryDelayMs: number;
	};
	steps: DigestArchiveStepResult[];
	skipped?: "already-running";
	error?: string;
}

export interface PeriodDigestArchiveFile {
	schemaVersion: 1;
	period: PeriodDigestPreset;
	contentSource: PeriodDigestContentSource;
	runDate: string;
	generatedAt: string;
	context: PeriodDigestContext;
	digest: PeriodDigestRunResult["digest"];
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
	cached: boolean;
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function trySync<T>(try_: () => T) {
	return Effect.try({ try: try_, catch: (error) => error });
}

function formatLocalDateFolder(date: Date) {
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function getDefaultDigestArchiveAuditLogPath() {
	return path.join(getBirdclawPaths().rootDir, "audit", "digest-archive.jsonl");
}

export function digestArchiveLockPath(period: PeriodDigestPreset) {
	return path.join(
		getBirdclawPaths().rootDir,
		"locks",
		`digest-archive-${period}.lock`,
	);
}

export function resolveDigestScheduleTime(
	period: PeriodDigestPreset,
	override?: DigestScheduleTime,
): { hour: number; minute: number; weekday?: number } {
	const fallback = DEFAULT_DIGEST_SCHEDULE_BY_PERIOD[period];
	const configured =
		getBirdclawConfig().digest?.schedule?.[period as DigestSchedulePeriod];
	const hour = override?.hour ?? configured?.hour ?? fallback.hour;
	const minute = override?.minute ?? configured?.minute ?? fallback.minute;
	const weekday =
		period === "week"
			? (override?.weekday ?? configured?.weekday ?? fallback.weekday)
			: undefined;
	return { hour, minute, ...(weekday === undefined ? {} : { weekday }) };
}

export function resolveDigestArchivePaths({
	archiveDir,
	runDate,
	period,
	contentSource,
}: {
	archiveDir: string;
	runDate: string;
	period: PeriodDigestPreset;
	contentSource: PeriodDigestContentSource;
}) {
	const base = path.join(archiveDir, runDate, `${period}-${contentSource}`);
	return { markdownPath: `${base}.md`, jsonPath: `${base}.json` };
}

function retryEffect<A>(
	attempt: () => Effect.Effect<A, unknown>,
	retriesLeft: number,
	delayMs: number,
): Effect.Effect<A, unknown> {
	return attempt().pipe(
		Effect.catchAll((error) =>
			retriesLeft <= 0
				? Effect.fail(error)
				: Effect.sleep(delayMs).pipe(
						Effect.andThen(() =>
							retryEffect(attempt, retriesLeft - 1, delayMs),
						),
					),
		),
	);
}

function runOneContentSourceEffect({
	period,
	contentSource,
	account,
	includeDms,
	archiveDir,
	runDate,
	retries,
	retryDelayMs,
}: {
	period: PeriodDigestPreset;
	contentSource: PeriodDigestContentSource;
	account?: string;
	includeDms?: boolean;
	archiveDir: string;
	runDate: string;
	retries: number;
	retryDelayMs: number;
}): Effect.Effect<DigestArchiveStepResult, never> {
	let attempts = 0;
	const attempt = () =>
		Effect.gen(function* () {
			attempts += 1;
			const result = yield* tryPromise(() =>
				streamPeriodDigest({
					period,
					contentSource,
					account,
					includeDms,
					refresh: true,
					liveSync: true,
				}),
			);
			const { markdownPath, jsonPath } = resolveDigestArchivePaths({
				archiveDir,
				runDate,
				period,
				contentSource,
			});
			yield* tryPromise(() =>
				fs.mkdir(path.dirname(markdownPath), { recursive: true }),
			);
			const archiveFile: PeriodDigestArchiveFile = {
				schemaVersion: 1,
				period,
				contentSource,
				runDate,
				generatedAt: result.updatedAt,
				context: result.context,
				digest: result.digest,
				markdown: result.markdown,
				model: result.model,
				reasoningEffort: result.reasoningEffort,
				serviceTier: result.serviceTier,
				cached: result.cached,
			};
			yield* tryPromise(() =>
				fs.writeFile(markdownPath, result.markdown, "utf8"),
			);
			yield* tryPromise(() =>
				fs.writeFile(jsonPath, JSON.stringify(archiveFile, null, "\t"), "utf8"),
			);
			return {
				contentSource,
				ok: true,
				attempts,
				cached: result.cached,
				updatedAt: result.updatedAt,
				markdownPath,
				jsonPath,
			} satisfies DigestArchiveStepResult;
		});

	return retryEffect(attempt, retries, retryDelayMs).pipe(
		Effect.catchAll((error) =>
			Effect.succeed({
				contentSource,
				ok: false,
				attempts,
				cached: false,
				error: messageFromError(error),
			} satisfies DigestArchiveStepResult),
		),
	);
}

export function runDigestArchiveJobEffect(
	options: DigestArchiveJobOptions,
): Effect.Effect<DigestArchiveAuditEntry, unknown> {
	return Effect.gen(function* () {
		const { period } = options;
		const archiveDir = yield* trySync(() =>
			resolveDigestArchiveDir(options.archiveDir),
		);
		const contentSources = options.contentSources ?? DEFAULT_CONTENT_SOURCES;
		const retries = options.retries ?? DEFAULT_DIGEST_ARCHIVE_RETRIES;
		const retryDelayMs =
			options.retryDelayMs ?? DEFAULT_DIGEST_ARCHIVE_RETRY_DELAY_MS;
		const includeDms = options.includeDms ?? false;
		const resolvedLogPath = yield* trySync(() =>
			resolveUserPath(options.logPath ?? getDefaultDigestArchiveAuditLogPath()),
		);
		const resolvedLockPath = yield* trySync(() =>
			resolveUserPath(options.lockPath ?? digestArchiveLockPath(period)),
		);
		const run = startScheduledJobRun();
		const runDate = yield* trySync(() =>
			formatLocalDateFolder(options.now?.() ?? new Date()),
		);
		const auditOptions = {
			period,
			...(options.account ? { account: options.account } : {}),
			includeDms,
			contentSources,
			archiveDir,
			retries,
			retryDelayMs,
		};

		const releaseLock = yield* acquireScheduledJobLockEffect(
			resolvedLockPath,
			DEFAULT_LOCK_STALE_MS,
		);
		if (!releaseLock) {
			const entry: DigestArchiveAuditEntry = {
				job: "digest-archive",
				period,
				ok: true,
				...run.finish(),
				runDate,
				options: auditOptions,
				steps: [],
				skipped: "already-running",
			};
			yield* appendScheduledJobAuditEffect(resolvedLogPath, entry);
			return entry;
		}

		return yield* Effect.gen(function* () {
			const steps: DigestArchiveStepResult[] = [];
			for (const contentSource of contentSources) {
				const step = yield* runOneContentSourceEffect({
					period,
					contentSource,
					account: options.account,
					includeDms,
					archiveDir,
					runDate,
					retries,
					retryDelayMs,
				});
				steps.push(step);
			}
			const entry: DigestArchiveAuditEntry = {
				job: "digest-archive",
				period,
				ok: steps.every((step) => step.ok),
				...run.finish(),
				runDate,
				options: auditOptions,
				steps,
			};
			yield* appendScheduledJobAuditEffect(resolvedLogPath, entry);
			return entry;
		}).pipe(Effect.ensuring(releaseLock()));
	});
}

export function runDigestArchiveJob(
	options: DigestArchiveJobOptions,
): Promise<DigestArchiveAuditEntry> {
	return runEffectPromise(runDigestArchiveJobEffect(options));
}

export interface DigestArchiveLaunchAgentOptions {
	period: PeriodDigestPreset;
	label?: string;
	hour?: number;
	minute?: number;
	weekday?: number;
	program?: string;
	account?: string;
	includeDms?: boolean;
	contentSources?: PeriodDigestContentSource[];
	archiveDir?: string;
	retries?: number;
	retryDelaySeconds?: number;
	logPath?: string;
	envFile?: string;
	stdoutPath?: string;
	stderrPath?: string;
	launchAgentsDir?: string;
	load?: boolean;
}

function digestArchiveLabel(period: PeriodDigestPreset) {
	return `com.steipete.birdclaw.digest-archive-${period}`;
}

function buildProgramArguments({
	program = "birdclaw",
	period,
	account,
	includeDms,
	contentSources,
	archiveDir,
	retries,
	retryDelaySeconds,
	logPath,
	envFile,
}: DigestArchiveLaunchAgentOptions & { logPath: string }) {
	const args = [
		"--json",
		"jobs",
		"run-digest-archive",
		"--period",
		period,
		"--log",
		resolveUserPath(logPath),
	];
	if (account) args.push("--account", account);
	if (includeDms) args.push("--include-dms");
	if (contentSources?.length) {
		args.push("--content-sources", contentSources.join(","));
	}
	if (archiveDir) args.push("--archive-dir", resolveUserPath(archiveDir));
	if (retries !== undefined) args.push("--retries", String(retries));
	if (retryDelaySeconds !== undefined) {
		args.push("--retry-delay-seconds", String(retryDelaySeconds));
	}
	return buildLaunchProgramArguments({ program, args, envFile });
}

export function buildDigestArchiveLaunchAgentPlist(
	options: DigestArchiveLaunchAgentOptions,
) {
	const { period } = options;
	const label = options.label ?? digestArchiveLabel(period);
	const { hour, minute, weekday } = resolveDigestScheduleTime(period, {
		hour: options.hour,
		minute: options.minute,
		weekday: options.weekday,
	});
	const logPath = resolveUserPath(
		options.logPath ?? getDefaultDigestArchiveAuditLogPath(),
	);
	const stdoutPath = resolveUserPath(
		options.stdoutPath ??
			path.join(
				getBirdclawPaths().rootDir,
				"logs",
				`digest-archive-${period}.out.log`,
			),
	);
	const stderrPath = resolveUserPath(
		options.stderrPath ??
			path.join(
				getBirdclawPaths().rootDir,
				"logs",
				`digest-archive-${period}.err.log`,
			),
	);
	const programArguments = buildProgramArguments({ ...options, logPath });
	return buildLaunchAgent({
		label,
		schedule: {
			kind: "calendar",
			hour,
			minute,
			...(weekday === undefined ? {} : { weekday }),
		},
		logPath,
		stdoutPath,
		stderrPath,
		programArguments,
		envFile: options.envFile,
	});
}

export function installDigestArchiveLaunchAgentEffect(
	options: DigestArchiveLaunchAgentOptions,
): Effect.Effect<LaunchAgentInstallResult, unknown> {
	return Effect.gen(function* () {
		const agent = yield* trySync(() =>
			buildDigestArchiveLaunchAgentPlist(options),
		);
		return yield* installLaunchAgentEffect(agent, options);
	});
}

export function installDigestArchiveLaunchAgent(
	options: DigestArchiveLaunchAgentOptions,
): Promise<LaunchAgentInstallResult> {
	return runEffectPromise(installDigestArchiveLaunchAgentEffect(options));
}

const ALL_PERIODS: PeriodDigestPreset[] = ["today", "24h", "yesterday", "week"];

export type DigestArchiveInstallAllResult = Record<
	PeriodDigestPreset,
	{ ok: true; result: LaunchAgentInstallResult } | { ok: false; error: string }
>;

export function installAllDigestArchiveLaunchAgentsEffect(
	overrides: Partial<
		Record<PeriodDigestPreset, Partial<DigestArchiveLaunchAgentOptions>>
	> = {},
	installOptions: LaunchAgentInstallOptions = {},
): Effect.Effect<DigestArchiveInstallAllResult, never> {
	return Effect.gen(function* () {
		const result = {} as DigestArchiveInstallAllResult;
		for (const period of ALL_PERIODS) {
			const perPeriodOptions: DigestArchiveLaunchAgentOptions = {
				period,
				...overrides[period],
				...installOptions,
			};
			const installed = yield* installDigestArchiveLaunchAgentEffect(
				perPeriodOptions,
			).pipe(
				Effect.map((value) => ({ ok: true as const, result: value })),
				Effect.catchAll((error) =>
					Effect.succeed({
						ok: false as const,
						error: messageFromError(error),
					}),
				),
			);
			result[period] = installed;
		}
		return result;
	});
}

export function installAllDigestArchiveLaunchAgents(
	overrides?: Partial<
		Record<PeriodDigestPreset, Partial<DigestArchiveLaunchAgentOptions>>
	>,
	installOptions?: LaunchAgentInstallOptions,
): Promise<DigestArchiveInstallAllResult> {
	return runEffectPromise(
		installAllDigestArchiveLaunchAgentsEffect(overrides, installOptions),
	);
}

export function parseDigestContentSources(
	value: string | undefined,
): PeriodDigestContentSource[] | undefined {
	if (!value) return undefined;
	const valid = new Set<PeriodDigestContentSource>(DEFAULT_CONTENT_SOURCES);
	const sources = value
		.split(",")
		.map((source) => source.trim())
		.filter(Boolean);
	if (sources.length === 0) return undefined;
	for (const source of sources) {
		if (!valid.has(source as PeriodDigestContentSource)) {
			throw new Error(
				`--content-sources must contain ${Array.from(valid).join(", ")}`,
			);
		}
	}
	return sources as PeriodDigestContentSource[];
}

async function listDigestArchiveDatesAsync({
	archiveDir,
	period,
}: {
	archiveDir: string;
	period: PeriodDigestPreset;
}): Promise<
	Array<{ date: string; contentSources: PeriodDigestContentSource[] }>
> {
	const entries = await fs
		.readdir(archiveDir, { withFileTypes: true })
		.catch(() => []);
	const dateDirs = entries
		.filter(
			(entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name),
		)
		.map((entry) => entry.name)
		.sort()
		.reverse();

	const results: Array<{
		date: string;
		contentSources: PeriodDigestContentSource[];
	}> = [];
	for (const date of dateDirs) {
		const contentSources: PeriodDigestContentSource[] = [];
		for (const contentSource of DEFAULT_CONTENT_SOURCES) {
			const { jsonPath } = resolveDigestArchivePaths({
				archiveDir,
				runDate: date,
				period,
				contentSource,
			});
			const exists = await fs
				.access(jsonPath)
				.then(() => true)
				.catch(() => false);
			if (exists) contentSources.push(contentSource);
		}
		if (contentSources.length > 0) results.push({ date, contentSources });
	}
	return results;
}

export function listDigestArchiveDates(options: {
	archiveDir: string;
	period: PeriodDigestPreset;
}) {
	return listDigestArchiveDatesAsync(options);
}

export function listDigestArchiveDatesEffect(options: {
	archiveDir: string;
	period: PeriodDigestPreset;
}) {
	return tryPromise(() => listDigestArchiveDatesAsync(options));
}

async function readDigestArchiveEntryAsync({
	archiveDir,
	period,
	contentSource,
	date,
}: {
	archiveDir: string;
	period: PeriodDigestPreset;
	contentSource: PeriodDigestContentSource;
	date: string;
}): Promise<PeriodDigestArchiveFile | null> {
	const { jsonPath } = resolveDigestArchivePaths({
		archiveDir,
		runDate: date,
		period,
		contentSource,
	});
	const raw = await fs.readFile(jsonPath, "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as PeriodDigestArchiveFile;
	} catch {
		return null;
	}
}

export function readDigestArchiveEntry(options: {
	archiveDir: string;
	period: PeriodDigestPreset;
	contentSource: PeriodDigestContentSource;
	date: string;
}) {
	return readDigestArchiveEntryAsync(options);
}

export function readDigestArchiveEntryEffect(options: {
	archiveDir: string;
	period: PeriodDigestPreset;
	contentSource: PeriodDigestContentSource;
	date: string;
}) {
	return tryPromise(() => readDigestArchiveEntryAsync(options));
}

export async function peekDigestArchiveRunningPeriods(): Promise<
	PeriodDigestPreset[]
> {
	const running: PeriodDigestPreset[] = [];
	for (const period of ALL_PERIODS) {
		const isRunning = await peekScheduledJobLock(
			digestArchiveLockPath(period),
			DEFAULT_LOCK_STALE_MS,
		);
		if (isRunning) running.push(period);
	}
	return running;
}

export function peekDigestArchiveRunningPeriodsEffect(): Effect.Effect<
	PeriodDigestPreset[],
	unknown
> {
	return Effect.all(
		ALL_PERIODS.map((period) =>
			peekScheduledJobLockEffect(
				digestArchiveLockPath(period),
				DEFAULT_LOCK_STALE_MS,
			).pipe(Effect.map((isRunning) => (isRunning ? period : undefined))),
		),
	).pipe(
		Effect.map((values) =>
			values.filter((v): v is PeriodDigestPreset => v !== undefined),
		),
	);
}
