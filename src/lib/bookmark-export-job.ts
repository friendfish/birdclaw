import path from "node:path";
import { Effect } from "effect";
import { exportBookmarks, type BookmarkExportResult } from "./bookmark-export";
import {
	ensureBirdclawDirs,
	getBirdclawPaths,
	resolveBookmarkArchiveDir,
	resolveBookmarkExportSchedule,
} from "./config";
import { runEffectPromise } from "./effect-runtime";
import {
	buildLaunchAgent,
	buildLaunchProgramArguments,
	installLaunchAgentEffect,
	resolveUserPath,
	type LaunchAgentInstallResult,
} from "./launchd";
import {
	acquireScheduledJobLockEffect,
	appendScheduledJobAuditEffect,
	startScheduledJobRun,
} from "./scheduled-job";

const DEFAULT_LAUNCHD_LABEL = "com.steipete.birdclaw.bookmark-export";
const DEFAULT_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export interface BookmarkExportJobOptions {
	account?: string;
	archiveDir?: string;
	full?: boolean;
	logPath?: string;
	lockPath?: string;
}

export interface BookmarkExportAuditEntry {
	job: "bookmark-export";
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	host: string;
	pid: number;
	options: {
		account?: string;
		archiveDir: string;
		full: boolean;
	};
	export?: BookmarkExportResult;
	skipped?: "already-running";
	error?: string;
}

export interface BookmarkExportLaunchAgentOptions {
	account?: string;
	archiveDir?: string;
	full?: boolean;
	label?: string;
	hour?: number;
	minute?: number;
	program?: string;
	logPath?: string;
	envFile?: string;
	stdoutPath?: string;
	stderrPath?: string;
	launchAgentsDir?: string;
	load?: boolean;
}

export function getDefaultBookmarkExportAuditLogPath() {
	return path.join(
		getBirdclawPaths().rootDir,
		"audit",
		"bookmark-export.jsonl",
	);
}

export function getDefaultBookmarkExportLockPath() {
	return path.join(getBirdclawPaths().rootDir, "locks", "bookmark-export.lock");
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({ try: try_, catch: toError });
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function exportFailureMessage(result: BookmarkExportResult) {
	if (result.errors.length === 0) return "Bookmark export failed";
	return result.errors
		.map((entry) => `${entry.path}: ${entry.error}`)
		.join("; ");
}

export function runBookmarkExportJobEffect({
	account,
	archiveDir,
	full = false,
	logPath,
	lockPath,
}: BookmarkExportJobOptions = {}): Effect.Effect<
	BookmarkExportAuditEntry,
	unknown
> {
	return Effect.gen(function* () {
		yield* trySync(() => ensureBirdclawDirs());
		const resolvedArchiveDir = yield* trySync(() =>
			resolveBookmarkArchiveDir(archiveDir),
		);
		const resolvedLogPath = yield* trySync(() =>
			resolveUserPath(logPath ?? getDefaultBookmarkExportAuditLogPath()),
		);
		const resolvedLockPath = yield* trySync(() =>
			resolveUserPath(lockPath ?? getDefaultBookmarkExportLockPath()),
		);
		const run = startScheduledJobRun();
		const jobOptions = {
			...(account ? { account } : {}),
			archiveDir: resolvedArchiveDir,
			full,
		};
		const releaseLock = yield* acquireScheduledJobLockEffect(
			resolvedLockPath,
			DEFAULT_LOCK_STALE_MS,
		);
		if (!releaseLock) {
			const entry: BookmarkExportAuditEntry = {
				job: "bookmark-export",
				ok: true,
				...run.finish(),
				options: jobOptions,
				skipped: "already-running",
			};
			yield* appendScheduledJobAuditEffect(resolvedLogPath, entry);
			return entry;
		}

		return yield* Effect.gen(function* () {
			const entry = yield* Effect.tryPromise({
				try: () =>
					exportBookmarks({
						account,
						archiveDir: resolvedArchiveDir,
						full,
					}),
				catch: toError,
			}).pipe(
				Effect.map(
					(result) =>
						({
							job: "bookmark-export",
							ok: result.ok,
							...run.finish(),
							options: jobOptions,
							export: result,
							...(result.ok ? {} : { error: exportFailureMessage(result) }),
						}) satisfies BookmarkExportAuditEntry,
				),
				Effect.catchAll((error) =>
					Effect.succeed({
						job: "bookmark-export",
						ok: false,
						...run.finish(),
						options: jobOptions,
						error: messageFromError(error),
					} satisfies BookmarkExportAuditEntry),
				),
			);
			yield* appendScheduledJobAuditEffect(resolvedLogPath, entry);
			return entry;
		}).pipe(Effect.ensuring(releaseLock()));
	});
}

export function runBookmarkExportJob(
	options: BookmarkExportJobOptions = {},
): Promise<BookmarkExportAuditEntry> {
	return runEffectPromise(runBookmarkExportJobEffect(options));
}

function assertScheduleField(
	value: number,
	field: "hour" | "minute",
	maximum: number,
) {
	if (!Number.isInteger(value) || value < 0 || value > maximum) {
		throw new Error(`${field} must be an integer from 0 to ${String(maximum)}`);
	}
	return value;
}

function buildProgramArguments({
	program = "birdclaw",
	account,
	archiveDir,
	full = false,
	logPath,
	envFile,
}: BookmarkExportLaunchAgentOptions & { logPath: string }) {
	const args = [
		"--json",
		"jobs",
		"export-bookmarks",
		"--log",
		resolveUserPath(logPath),
	];
	if (account) args.push("--account", account);
	if (archiveDir) args.push("--archive-dir", resolveUserPath(archiveDir));
	if (full) args.push("--full");
	return buildLaunchProgramArguments({ program, args, envFile });
}

export function buildBookmarkExportLaunchAgentPlist(
	options: BookmarkExportLaunchAgentOptions = {},
) {
	const configuredSchedule = resolveBookmarkExportSchedule();
	const hour = assertScheduleField(
		options.hour ?? configuredSchedule.hour,
		"hour",
		23,
	);
	const minute = assertScheduleField(
		options.minute ?? configuredSchedule.minute,
		"minute",
		59,
	);
	const logPath = resolveUserPath(
		options.logPath ?? getDefaultBookmarkExportAuditLogPath(),
	);
	const stdoutPath = resolveUserPath(
		options.stdoutPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "bookmark-export.out.log"),
	);
	const stderrPath = resolveUserPath(
		options.stderrPath ??
			path.join(getBirdclawPaths().rootDir, "logs", "bookmark-export.err.log"),
	);
	return buildLaunchAgent({
		label: options.label ?? DEFAULT_LAUNCHD_LABEL,
		schedule: { kind: "calendar", hour, minute },
		logPath,
		stdoutPath,
		stderrPath,
		programArguments: buildProgramArguments({ ...options, logPath }),
		envFile: options.envFile,
		runAtLoad: false,
	});
}

export function installBookmarkExportLaunchAgentEffect(
	options: BookmarkExportLaunchAgentOptions = {},
): Effect.Effect<LaunchAgentInstallResult, unknown> {
	return Effect.gen(function* () {
		const agent = yield* trySync(() =>
			buildBookmarkExportLaunchAgentPlist(options),
		);
		yield* trySync(() => ensureBirdclawDirs());
		return yield* installLaunchAgentEffect(agent, options);
	});
}

export function installBookmarkExportLaunchAgent(
	options: BookmarkExportLaunchAgentOptions = {},
): Promise<LaunchAgentInstallResult> {
	return runEffectPromise(installBookmarkExportLaunchAgentEffect(options));
}
