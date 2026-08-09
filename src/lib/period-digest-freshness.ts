import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getBirdCredentialsPath } from "./bird-credentials";
import {
	getBirdclawPaths,
	resolveDigestFreshnessSeconds,
	resolveDigestLaunchdExecution,
	type DigestScheduleTime,
} from "./config";
import { resolveDigestScheduleTime } from "./digest-archive-job";
import {
	buildLaunchAgent,
	buildLaunchProgramArguments,
	installLaunchAgent,
	type LaunchAgent,
	type LaunchAgentInstallOptions,
	type LaunchAgentInstallResult,
} from "./launchd";
import {
	readCurrentPeriodDigest,
	type CurrentPeriodDigestPeriod,
} from "./period-digest-current-store";
import type { PeriodDigestContentSource } from "./period-digest";
import { acquireScheduledJobLock } from "./scheduled-job";

export interface PeriodDigestFreshnessStateV1 {
	schemaVersion: 1;
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	dueAt: string;
	fireAt: string;
	status:
		| "scheduled"
		| "running"
		| "retryable"
		| "failed"
		| "consumed"
		| "disabled"
		| "error";
	updatedAt: string;
	consumedAt?: string;
	completedAt?: string;
	startedAt?: string;
	failedAt?: string;
	installError?: string;
	retryCount?: number;
	retryAt?: string;
	pageRecoveryUsedAt?: string;
	freshnessSeconds?: number;
	sourceIdentities?: Partial<Record<PeriodDigestContentSource, string>>;
	suppressedSourceIdentities?: Partial<
		Record<PeriodDigestContentSource, string>
	>;
}

export type PeriodDigestFreshnessOrigin = "launchd" | "page" | "cli";

export interface CalculateFreshnessDeadlineInput {
	now: Date;
	freshnessSeconds: number;
	schedule: Required<Pick<DigestScheduleTime, "hour" | "minute">>;
	generatedAt: Partial<Record<PeriodDigestContentSource, string>>;
	suppressedSources?: PeriodDigestContentSource[];
}

const CONTENT_SOURCES: PeriodDigestContentSource[] = [
	"all",
	"following",
	"for_you",
];
const stateQueues = new Map<string, Promise<void>>();
const reconcileQueues = new Map<CurrentPeriodDigestPeriod, Promise<void>>();
const FRESHNESS_SCHEDULER_LOCK_STALE_MS = 60_000;
const FRESHNESS_SCHEDULER_LOCK_MAX_AGE_MS = 10 * 60_000;
const FRESHNESS_SCHEDULER_LOCK_WAIT_MS = 30_000;
const FRESHNESS_RETRY_DELAYS_MS = [
	15 * 60_000,
	60 * 60_000,
	4 * 60 * 60_000,
] as const;

function sameLocalDay(left: Date, right: Date) {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

function roundUpToMinute(value: Date) {
	const rounded = new Date(value);
	if (rounded.getSeconds() !== 0 || rounded.getMilliseconds() !== 0) {
		rounded.setMinutes(rounded.getMinutes() + 1);
	}
	rounded.setSeconds(0, 0);
	return rounded;
}

export function calculatePeriodDigestFreshnessDeadline({
	now,
	freshnessSeconds,
	schedule,
	generatedAt,
	suppressedSources = [],
}: CalculateFreshnessDeadlineInput) {
	const scheduledBase = new Date(now);
	scheduledBase.setHours(schedule.hour, schedule.minute, 0, 0);
	const suppressed = new Set(suppressedSources);
	const candidates = CONTENT_SOURCES.filter(
		(contentSource) => !suppressed.has(contentSource),
	).map((contentSource) => {
		const generated = new Date(generatedAt[contentSource] ?? "");
		const base =
			Number.isFinite(generated.getTime()) && sameLocalDay(generated, now)
				? generated
				: scheduledBase;
		return new Date(base.getTime() + freshnessSeconds * 1_000);
	});
	if (candidates.length === 0) return null;
	const deadline = new Date(
		Math.min(...candidates.map((candidate) => candidate.getTime())),
	);
	return sameLocalDay(deadline, now) ? deadline : null;
}

function periodDigestFreshnessSchedulerLockPath(
	period: CurrentPeriodDigestPeriod,
) {
	return path.join(
		getBirdclawPaths().rootDir,
		"locks",
		`period-digest-freshness-${period}.lock`,
	);
}

async function withFreshnessSchedulerLease<T>(
	period: CurrentPeriodDigestPeriod,
	operation: () => Promise<T>,
) {
	const lockPath = periodDigestFreshnessSchedulerLockPath(period);
	const deadline = Date.now() + FRESHNESS_SCHEDULER_LOCK_WAIT_MS;
	for (;;) {
		const release = await acquireScheduledJobLock(
			lockPath,
			FRESHNESS_SCHEDULER_LOCK_STALE_MS,
			{},
			FRESHNESS_SCHEDULER_LOCK_MAX_AGE_MS,
		);
		if (release) {
			try {
				return await operation();
			} finally {
				await release();
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out reconciling ${period} freshness schedule`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export function periodDigestFreshnessStatePath(
	period: CurrentPeriodDigestPeriod,
) {
	return path.join(
		getBirdclawPaths().rootDir,
		"runs",
		`period-digest-freshness-${period}.json`,
	);
}

function serializeState<T>(statePath: string, mutation: () => Promise<T>) {
	const previous = stateQueues.get(statePath) ?? Promise.resolve();
	const operation = previous.then(mutation);
	const tail = operation.then(
		() => undefined,
		() => undefined,
	);
	stateQueues.set(statePath, tail);
	return operation.finally(() => {
		if (stateQueues.get(statePath) === tail) stateQueues.delete(statePath);
	});
}

function serializeReconcile<T>(
	period: CurrentPeriodDigestPeriod,
	operation: () => Promise<T>,
) {
	const previous = reconcileQueues.get(period) ?? Promise.resolve();
	const current = previous.then(operation);
	const tail = current.then(
		() => undefined,
		() => undefined,
	);
	reconcileQueues.set(period, tail);
	return current.finally(() => {
		if (reconcileQueues.get(period) === tail) reconcileQueues.delete(period);
	});
}

async function writeStateFile(
	statePath: string,
	state: PeriodDigestFreshnessStateV1,
) {
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(state, null, "\t")}\n`,
			"utf8",
		);
		await fs.rename(temporaryPath, statePath);
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export function writePeriodDigestFreshnessState(
	state: PeriodDigestFreshnessStateV1,
) {
	const statePath = periodDigestFreshnessStatePath(state.period);
	return serializeState(statePath, () => writeStateFile(statePath, state));
}

export async function readPeriodDigestFreshnessState(
	period: CurrentPeriodDigestPeriod,
) {
	const raw = await fs
		.readFile(periodDigestFreshnessStatePath(period), "utf8")
		.catch(() => undefined);
	if (raw === undefined) return undefined;
	try {
		const state = JSON.parse(raw) as Partial<PeriodDigestFreshnessStateV1>;
		return state.schemaVersion === 1 &&
			state.period === period &&
			typeof state.attemptToken === "string" &&
			typeof state.dueAt === "string" &&
			typeof state.fireAt === "string" &&
			typeof state.status === "string" &&
			typeof state.updatedAt === "string"
			? (state as PeriodDigestFreshnessStateV1)
			: undefined;
	} catch {
		return undefined;
	}
}

export function buildPeriodDigestFreshnessLaunchAgent({
	period,
	fireAt,
	attemptToken,
	program = "birdclaw",
	envFile,
}: {
	period: CurrentPeriodDigestPeriod;
	fireAt: Date;
	attemptToken: string;
	program?: string;
	envFile?: string;
}): LaunchAgent {
	const root = getBirdclawPaths().rootDir;
	return buildLaunchAgent({
		label: `com.steipete.birdclaw.period-digest-freshness-${period}`,
		schedule: {
			kind: "calendar",
			year: fireAt.getFullYear(),
			month: fireAt.getMonth() + 1,
			day: fireAt.getDate(),
			hour: fireAt.getHours(),
			minute: fireAt.getMinutes(),
		},
		runAtLoad: false,
		logPath: path.join(root, "logs", "period-digest-freshness.jsonl"),
		stdoutPath: path.join(
			root,
			"logs",
			`period-digest-freshness-${period}.out.log`,
		),
		stderrPath: path.join(
			root,
			"logs",
			`period-digest-freshness-${period}.err.log`,
		),
		programArguments: buildLaunchProgramArguments({
			program,
			envFile,
			args: [
				"--json",
				"jobs",
				"run-period-digest",
				"--period",
				period,
				"--trigger",
				"freshness",
				"--origin",
				"launchd",
				"--attempt-token",
				attemptToken,
				"--bird-credentials-path",
				getBirdCredentialsPath(),
			],
		}),
		envFile,
	});
}

export async function consumePeriodDigestFreshnessAttempt({
	period,
	attemptToken,
	origin,
	now = new Date(),
}: {
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	origin: PeriodDigestFreshnessOrigin;
	now?: Date;
}): Promise<
	| { valid: true }
	| {
			valid: false;
			reason:
				| "missing-state"
				| "token-mismatch"
				| "already-consumed"
				| "already-running"
				| "disabled"
				| "not-due"
				| "cross-day";
	  }
> {
	const statePath = periodDigestFreshnessStatePath(period);
	return withFreshnessSchedulerLease(period, () =>
		serializeState(statePath, async () => {
			const state = await readPeriodDigestFreshnessState(period);
			if (!state) return { valid: false, reason: "missing-state" } as const;
			if (state.attemptToken !== attemptToken) {
				return { valid: false, reason: "token-mismatch" } as const;
			}
			if (state.status === "disabled") {
				return { valid: false, reason: "disabled" } as const;
			}
			if (state.status === "running") {
				return { valid: false, reason: "already-running" } as const;
			}
			const terminal =
				state.status === "failed" ||
				state.status === "consumed" ||
				state.status === "error";
			const recoverableTerminal =
				state.status === "failed" ||
				state.status === "error" ||
				(state.status === "consumed" && !state.completedAt);
			const pageRecovery =
				origin === "page" && recoverableTerminal && !state.pageRecoveryUsedAt;
			if (terminal && !pageRecovery) {
				return { valid: false, reason: "already-consumed" } as const;
			}
			const dueAt = new Date(state.dueAt);
			if (!sameLocalDay(dueAt, now)) {
				return { valid: false, reason: "cross-day" } as const;
			}
			const eligibleAt = new Date(
				state.status === "retryable" ? (state.retryAt ?? "") : state.dueAt,
			);
			if (
				!pageRecovery &&
				(!Number.isFinite(eligibleAt.getTime()) ||
					now.getTime() < eligibleAt.getTime())
			) {
				return { valid: false, reason: "not-due" } as const;
			}
			await writeStateFile(statePath, {
				...state,
				status: "running",
				startedAt: now.toISOString(),
				updatedAt: now.toISOString(),
				...(pageRecovery ? { pageRecoveryUsedAt: now.toISOString() } : {}),
			});
			return { valid: true } as const;
		}),
	);
}

export async function completePeriodDigestFreshnessAttempt({
	period,
	attemptToken,
	outcome,
	now = new Date(),
	install = installLaunchAgent,
	installOptions,
	program,
	envFile,
}: {
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	outcome: "published" | "failed";
	now?: Date;
	install?: (
		agent: LaunchAgent,
		options?: LaunchAgentInstallOptions,
	) => Promise<LaunchAgentInstallResult>;
	installOptions?: LaunchAgentInstallOptions;
	program?: string;
	envFile?: string;
}) {
	const statePath = periodDigestFreshnessStatePath(period);
	return withFreshnessSchedulerLease(period, () =>
		serializeState(statePath, async () => {
			const state = await readPeriodDigestFreshnessState(period);
			if (
				!state ||
				state.attemptToken !== attemptToken ||
				state.status !== "running"
			) {
				return { state, installResult: null, updated: false as const };
			}

			if (outcome === "published") {
				const consumed: PeriodDigestFreshnessStateV1 = {
					...state,
					status: "consumed",
					consumedAt: now.toISOString(),
					completedAt: now.toISOString(),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, consumed);
				return {
					state: consumed,
					installResult: null,
					updated: true as const,
				};
			}

			if (state.pageRecoveryUsedAt) {
				const failed: PeriodDigestFreshnessStateV1 = {
					...state,
					status: "failed",
					failedAt: now.toISOString(),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, failed);
				return {
					state: failed,
					installResult: null,
					updated: true as const,
				};
			}

			const retryCount = state.retryCount ?? 0;
			const retryDelay = FRESHNESS_RETRY_DELAYS_MS[retryCount];
			if (retryDelay === undefined) {
				const failed: PeriodDigestFreshnessStateV1 = {
					...state,
					status: "failed",
					failedAt: now.toISOString(),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, failed);
				return {
					state: failed,
					installResult: null,
					updated: true as const,
				};
			}

			const retryAt = roundUpToMinute(new Date(now.getTime() + retryDelay));
			if (!sameLocalDay(retryAt, now)) {
				const disabled: PeriodDigestFreshnessStateV1 = {
					...state,
					status: "disabled",
					retryCount: retryCount + 1,
					retryAt: retryAt.toISOString(),
					fireAt: "",
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, disabled);
				return {
					state: disabled,
					installResult: null,
					updated: true as const,
				};
			}

			const retryable: PeriodDigestFreshnessStateV1 = {
				...state,
				status: "retryable",
				retryCount: retryCount + 1,
				retryAt: retryAt.toISOString(),
				fireAt: retryAt.toISOString(),
				updatedAt: now.toISOString(),
			};
			await writeStateFile(statePath, retryable);
			const execution = resolveDigestLaunchdExecution();
			const agent = buildPeriodDigestFreshnessLaunchAgent({
				period,
				fireAt: retryAt,
				attemptToken,
				program: program ?? execution.program,
				envFile: envFile ?? execution.envFile,
			});
			try {
				const installResult = await install(agent, installOptions);
				return {
					state: retryable,
					installResult,
					updated: true as const,
				};
			} catch (error) {
				const failedInstall: PeriodDigestFreshnessStateV1 = {
					...retryable,
					status: "error",
					installError: error instanceof Error ? error.message : String(error),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, failedInstall);
				return {
					state: failedInstall,
					installResult: null,
					updated: true as const,
				};
			}
		}),
	);
}

export async function triggerDuePeriodDigestFreshness({
	period,
	origin,
	now = new Date(),
	requestRun,
	completeAttempt = completePeriodDigestFreshnessAttempt,
}: {
	period: CurrentPeriodDigestPeriod;
	origin: "page" | "cli";
	now?: Date;
	requestRun?: (request: {
		period: CurrentPeriodDigestPeriod;
		trigger: "freshness";
		origin: "page" | "cli";
	}) => Promise<{
		runId: string;
		joined: boolean;
		completion: Promise<{ phase: "completed" | "degraded" | "failed" }>;
	}>;
	completeAttempt?: typeof completePeriodDigestFreshnessAttempt;
}) {
	let state = await readPeriodDigestFreshnessState(period);
	if (!state) {
		state = (await reconcilePeriodDigestFreshness({ period, now })).state;
	}
	if (state.status === "disabled") {
		return { triggered: false as const, reason: "disabled" as const };
	}
	const attempt = await consumePeriodDigestFreshnessAttempt({
		period,
		attemptToken: state.attemptToken,
		origin,
		now,
	});
	if (!attempt.valid) {
		return { triggered: false as const, reason: attempt.reason };
	}
	const run = requestRun
		? await requestRun({ period, trigger: "freshness", origin })
		: await import("./period-digest-orchestrator").then(
				({ requestPeriodDigestRun }) =>
					requestPeriodDigestRun({ period, trigger: "freshness", origin }),
			);
	void run.completion
		.then((finalState) =>
			completeAttempt({
				period,
				attemptToken: state.attemptToken,
				outcome: finalState.phase === "failed" ? "failed" : "published",
			}),
		)
		.catch(() => undefined);
	return {
		triggered: true as const,
		runId: run.runId,
		joined: run.joined,
	};
}

async function reconcilePeriodDigestFreshnessInternal({
	period,
	now = new Date(),
	freshnessSeconds = resolveDigestFreshnessSeconds(),
	schedule = resolveDigestScheduleTime(period),
	installOptions,
	install = installLaunchAgent,
	suppressSources = [],
	program,
	envFile,
}: {
	period: CurrentPeriodDigestPeriod;
	now?: Date;
	freshnessSeconds?: number;
	schedule?: Required<Pick<DigestScheduleTime, "hour" | "minute">>;
	installOptions?: LaunchAgentInstallOptions;
	install?: (
		agent: LaunchAgent,
		options?: LaunchAgentInstallOptions,
	) => Promise<LaunchAgentInstallResult>;
	suppressSources?: PeriodDigestContentSource[];
	program?: string;
	envFile?: string;
}) {
	const scheduledBase = new Date(now);
	scheduledBase.setHours(schedule.hour, schedule.minute, 0, 0);
	const currentBySource = Object.fromEntries(
		CONTENT_SOURCES.map((contentSource) => [
			contentSource,
			readCurrentPeriodDigest(period, contentSource),
		]),
	);
	const generatedAt = Object.fromEntries(
		CONTENT_SOURCES.flatMap((contentSource) => {
			const current = currentBySource[contentSource];
			return current ? [[contentSource, current.generatedAt]] : [];
		}),
	) as Partial<Record<PeriodDigestContentSource, string>>;
	const sourceIdentities = Object.fromEntries(
		CONTENT_SOURCES.map((contentSource) => [
			contentSource,
			currentBySource[contentSource]?.versionId ??
				`scheduled:${scheduledBase.toISOString()}`,
		]),
	) as Record<PeriodDigestContentSource, string>;
	const previous = await readPeriodDigestFreshnessState(period);
	const suppressedSourceIdentities = Object.fromEntries(
		CONTENT_SOURCES.flatMap((contentSource) => {
			const currentIdentity = sourceIdentities[contentSource];
			if (suppressSources.includes(contentSource)) {
				return [[contentSource, currentIdentity]];
			}
			const previousIdentity =
				previous?.freshnessSeconds === freshnessSeconds
					? previous.suppressedSourceIdentities?.[contentSource]
					: undefined;
			return previousIdentity === currentIdentity
				? [[contentSource, currentIdentity]]
				: [];
		}),
	) as Partial<Record<PeriodDigestContentSource, string>>;
	const activeSuppressions = CONTENT_SOURCES.filter(
		(contentSource) =>
			suppressedSourceIdentities[contentSource] ===
			sourceIdentities[contentSource],
	);
	const dueAt = calculatePeriodDigestFreshnessDeadline({
		now,
		freshnessSeconds,
		schedule,
		generatedAt,
		suppressedSources: activeSuppressions,
	});
	const attemptToken = createHash("sha256")
		.update(
			JSON.stringify({
				period,
				freshnessSeconds,
				schedule,
				sourceIdentities,
				suppressedSourceIdentities,
			}),
		)
		.digest("hex");
	if (!dueAt) {
		const state: PeriodDigestFreshnessStateV1 = {
			schemaVersion: 1,
			period,
			attemptToken,
			dueAt: "",
			fireAt: "",
			status: "disabled",
			updatedAt: now.toISOString(),
			freshnessSeconds,
			sourceIdentities,
			suppressedSourceIdentities,
		};
		await writePeriodDigestFreshnessState(state);
		return { state, installResult: null };
	}
	if (
		previous?.attemptToken === attemptToken &&
		(previous.status === "running" ||
			previous.status === "retryable" ||
			previous.status === "failed" ||
			previous.status === "consumed")
	) {
		return { state: previous, installResult: null };
	}
	const sameAttempt = previous?.attemptToken === attemptToken;
	const desiredFireAt =
		sameAttempt && previous.status === "error" && previous.retryAt
			? new Date(previous.retryAt)
			: dueAt;
	const fireAt = roundUpToMinute(
		desiredFireAt.getTime() <= now.getTime()
			? new Date(now.getTime() + 1)
			: desiredFireAt,
	);
	const state: PeriodDigestFreshnessStateV1 = {
		schemaVersion: 1,
		period,
		attemptToken,
		dueAt: dueAt.toISOString(),
		fireAt: fireAt.toISOString(),
		status: "scheduled",
		updatedAt: now.toISOString(),
		freshnessSeconds,
		sourceIdentities,
		suppressedSourceIdentities,
		...(sameAttempt && previous.retryCount !== undefined
			? { retryCount: previous.retryCount }
			: {}),
		...(sameAttempt && previous.retryAt ? { retryAt: previous.retryAt } : {}),
		...(sameAttempt && previous.pageRecoveryUsedAt
			? { pageRecoveryUsedAt: previous.pageRecoveryUsedAt }
			: {}),
	};
	await writePeriodDigestFreshnessState(state);
	const agent = buildPeriodDigestFreshnessLaunchAgent({
		period,
		fireAt,
		attemptToken,
		program: program ?? resolveDigestLaunchdExecution().program,
		envFile: envFile ?? resolveDigestLaunchdExecution().envFile,
	});
	try {
		const installResult = await install(agent, installOptions);
		return { state, installResult };
	} catch (error) {
		const failed: PeriodDigestFreshnessStateV1 = {
			...state,
			status: "error",
			installError: error instanceof Error ? error.message : String(error),
			updatedAt: new Date().toISOString(),
		};
		await writePeriodDigestFreshnessState(failed);
		return { state: failed, installResult: null };
	}
}

export function reconcilePeriodDigestFreshness(
	input: Parameters<typeof reconcilePeriodDigestFreshnessInternal>[0],
) {
	return serializeReconcile(input.period, () =>
		withFreshnessSchedulerLease(input.period, () =>
			reconcilePeriodDigestFreshnessInternal(input),
		),
	);
}

export async function reconcileAllPeriodDigestFreshness() {
	const [today, hour24] = await Promise.all([
		reconcilePeriodDigestFreshness({ period: "today" }),
		reconcilePeriodDigestFreshness({ period: "24h" }),
	]);
	return { today, "24h": hour24 };
}
