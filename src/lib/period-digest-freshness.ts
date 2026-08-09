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
	launchAgentPlistPath,
	shellQuote,
	type LaunchAgent,
	type LaunchAgentInstallOptions,
	type LaunchAgentInstallResult,
} from "./launchd";
import {
	readCurrentPeriodDigest,
	type CurrentPeriodDigestPeriod,
} from "./period-digest-current-store";
import type { PeriodDigestContentSource } from "./period-digest";
import {
	acquireScheduledJobLock,
	peekScheduledJobLockMetadata,
} from "./scheduled-job";

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
	runningOrigin?: PeriodDigestFreshnessOrigin;
	launchdCallerPid?: number;
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
const FRESHNESS_RUNNING_LEASE_MS = 15 * 60_000;
const FRESHNESS_RELOADER_WAIT_SECONDS = 6 * 60 * 60;

function periodDigestFreshnessLaunchAgentLabel(
	period: CurrentPeriodDigestPeriod,
) {
	return `com.steipete.birdclaw.period-digest-freshness-${period}`;
}

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

function resolveLaunchAgentFireAt(desiredAt: Date, now: Date) {
	const fireAt = roundUpToMinute(
		desiredAt.getTime() <= now.getTime()
			? new Date(now.getTime() + 1)
			: desiredAt,
	);
	return sameLocalDay(fireAt, now) ? fireAt : undefined;
}

function runningLeaseEligibleAt(state: PeriodDigestFreshnessStateV1) {
	const startedAt = new Date(state.startedAt ?? state.updatedAt);
	return Number.isFinite(startedAt.getTime())
		? new Date(startedAt.getTime() + FRESHNESS_RUNNING_LEASE_MS)
		: new Date(0);
}

function freshnessEligibilityAt(state: PeriodDigestFreshnessStateV1) {
	const retryAt =
		(state.status === "retryable" || state.status === "error") && state.retryAt
			? state.retryAt
			: undefined;
	return new Date(retryAt ?? state.dueAt);
}

function validProcessId(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

async function isPeriodDigestRunActive(period: CurrentPeriodDigestPeriod) {
	const { PERIOD_DIGEST_LOCK_STALE_MS, periodDigestRunLockPath } =
		await import("./period-digest-orchestrator");
	return Boolean(
		await peekScheduledJobLockMetadata(
			periodDigestRunLockPath(period),
			PERIOD_DIGEST_LOCK_STALE_MS,
		),
	);
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
		label: periodDigestFreshnessLaunchAgentLabel(period),
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

export function buildPeriodDigestFreshnessRetryReloaderLaunchAgent({
	period,
	attemptToken,
	parentPid = process.pid,
	program = "birdclaw",
	envFile,
	launchAgentsDir,
}: {
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	parentPid?: number;
	program?: string;
	envFile?: string;
	launchAgentsDir?: string;
}): LaunchAgent {
	const root = getBirdclawPaths().rootDir;
	const waitPid = validProcessId(parentPid) ? parentPid : process.pid;
	const label = `${periodDigestFreshnessLaunchAgentLabel(period)}-reloader`;
	const helperPlistPath = launchAgentPlistPath(label, { launchAgentsDir });
	const activationArguments = buildLaunchProgramArguments({
		program,
		envFile,
		args: [
			"--json",
			"jobs",
			"activate-period-digest-freshness-retry",
			"--period",
			period,
			"--attempt-token",
			attemptToken,
			...(launchAgentsDir ? ["--launch-agents-dir", launchAgentsDir] : []),
		],
	});
	const activationCommand = activationArguments.map(shellQuote).join(" ");
	const script = [
		`deadline=$(( $(/bin/date +%s) + ${String(FRESHNESS_RELOADER_WAIT_SECONDS)} ))`,
		`while /bin/kill -0 ${String(waitPid)} 2>/dev/null && [ "$(/bin/date +%s)" -lt "$deadline" ]; do /bin/sleep 1; done`,
		activationCommand,
		"activation_status=$?",
		`/usr/bin/unlink ${shellQuote(helperPlistPath)} 2>/dev/null || true`,
		`/bin/launchctl remove ${shellQuote(label)} >/dev/null 2>&1`,
		'exit "$activation_status"',
	].join("\n");
	return buildLaunchAgent({
		label,
		schedule: { kind: "interval", intervalSeconds: 24 * 60 * 60 },
		runAtLoad: true,
		logPath: path.join(root, "logs", "period-digest-freshness-reloader.jsonl"),
		stdoutPath: path.join(
			root,
			"logs",
			`period-digest-freshness-${period}-reloader.out.log`,
		),
		stderrPath: path.join(
			root,
			"logs",
			`period-digest-freshness-${period}-reloader.err.log`,
		),
		programArguments: ["/bin/bash", "-lc", script],
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
			eligibleAt?: string;
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
			const dueAt = new Date(state.dueAt);
			if (!sameLocalDay(dueAt, now)) {
				return { valid: false, reason: "cross-day" } as const;
			}
			if (state.status === "running") {
				const eligibleAt = runningLeaseEligibleAt(state);
				if (now.getTime() < eligibleAt.getTime()) {
					return {
						valid: false,
						reason: "already-running",
						eligibleAt: eligibleAt.toISOString(),
					} as const;
				}
			}
			const terminal =
				state.status === "failed" ||
				state.status === "consumed" ||
				state.status === "error";
			const retryInstallPending =
				state.status === "error" && Boolean(state.retryAt);
			const recoverableTerminal =
				state.status === "failed" ||
				(state.status === "error" && !retryInstallPending) ||
				(state.status === "consumed" && !state.completedAt);
			const pageRecovery =
				origin === "page" && recoverableTerminal && !state.pageRecoveryUsedAt;
			if (terminal && !pageRecovery && !retryInstallPending) {
				return { valid: false, reason: "already-consumed" } as const;
			}
			const eligibleAt = freshnessEligibilityAt(state);
			if (
				!Number.isFinite(eligibleAt.getTime()) ||
				now.getTime() < eligibleAt.getTime()
			) {
				return {
					valid: false,
					reason: "not-due",
					...(Number.isFinite(eligibleAt.getTime())
						? { eligibleAt: eligibleAt.toISOString() }
						: {}),
				} as const;
			}
			const { launchdCallerPid, ...stateWithoutLaunchdCallerPid } = state;
			const retainedLaunchdCallerPid =
				state.status === "running" && validProcessId(launchdCallerPid)
					? launchdCallerPid
					: undefined;
			await writeStateFile(statePath, {
				...stateWithoutLaunchdCallerPid,
				status: "running",
				startedAt: now.toISOString(),
				runningOrigin: origin,
				...(origin === "launchd"
					? { launchdCallerPid: process.pid }
					: retainedLaunchdCallerPid !== undefined
						? { launchdCallerPid: retainedLaunchdCallerPid }
						: {}),
				updatedAt: now.toISOString(),
				...(pageRecovery ? { pageRecoveryUsedAt: now.toISOString() } : {}),
			});
			return { valid: true } as const;
		}),
	);
}

export async function activatePeriodDigestFreshnessRetry({
	period,
	attemptToken,
	now = new Date(),
	install = installLaunchAgent,
	installOptions,
	program,
	envFile,
}: {
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
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
			if (!state) {
				return {
					activated: false as const,
					reason: "missing-state" as const,
					state,
					installResult: null,
				};
			}
			if (state.attemptToken !== attemptToken) {
				return {
					activated: false as const,
					reason: "token-mismatch" as const,
					state,
					installResult: null,
				};
			}
			if (state.status !== "scheduled" && state.status !== "retryable") {
				return {
					activated: false as const,
					reason: "not-activatable" as const,
					state,
					installResult: null,
				};
			}
			const dueAt = new Date(state.dueAt);
			const desiredActivationAt = new Date(
				state.status === "retryable"
					? (state.retryAt ?? state.fireAt)
					: state.fireAt,
			);
			const activationAt = Number.isFinite(desiredActivationAt.getTime())
				? resolveLaunchAgentFireAt(desiredActivationAt, now)
				: undefined;
			if (
				!activationAt ||
				!sameLocalDay(dueAt, now) ||
				!sameLocalDay(desiredActivationAt, now)
			) {
				const disabled: PeriodDigestFreshnessStateV1 = {
					...state,
					status: "disabled",
					fireAt: "",
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, disabled);
				return {
					activated: false as const,
					reason: "cross-day" as const,
					state: disabled,
					installResult: null,
				};
			}

			const activationState: PeriodDigestFreshnessStateV1 = {
				...state,
				fireAt: activationAt.toISOString(),
				updatedAt: now.toISOString(),
			};
			await writeStateFile(statePath, activationState);
			const execution = resolveDigestLaunchdExecution();
			const agent = buildPeriodDigestFreshnessLaunchAgent({
				period,
				fireAt: activationAt,
				attemptToken,
				program: program ?? execution.program,
				envFile: envFile ?? execution.envFile,
			});
			try {
				const installResult = await install(agent, installOptions);
				return {
					activated: true as const,
					state: activationState,
					installResult,
				};
			} catch (error) {
				const failedInstall: PeriodDigestFreshnessStateV1 = {
					...activationState,
					status: "error",
					installError: error instanceof Error ? error.message : String(error),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, failedInstall);
				return {
					activated: false as const,
					reason: "install-error" as const,
					state: failedInstall,
					installResult: null,
				};
			}
		}),
	);
}

export async function completePeriodDigestFreshnessAttempt({
	period,
	attemptToken,
	origin,
	outcome,
	now = new Date(),
	install = installLaunchAgent,
	installOptions,
	program,
	envFile,
}: {
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	origin: PeriodDigestFreshnessOrigin;
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
			const launchdCallerPid = validProcessId(state.launchdCallerPid)
				? state.launchdCallerPid
				: undefined;
			const agent =
				origin === "launchd" || launchdCallerPid !== undefined
					? buildPeriodDigestFreshnessRetryReloaderLaunchAgent({
							period,
							attemptToken,
							parentPid: launchdCallerPid,
							program: program ?? execution.program,
							envFile: envFile ?? execution.envFile,
							launchAgentsDir: installOptions?.launchAgentsDir,
						})
					: buildPeriodDigestFreshnessLaunchAgent({
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
		return {
			triggered: false as const,
			reason: attempt.reason,
			...(attempt.eligibleAt ? { eligibleAt: attempt.eligibleAt } : {}),
		};
	}
	const reportFailedAttempt = () =>
		completeAttempt({
			period,
			attemptToken: state.attemptToken,
			origin,
			outcome: "failed",
		});
	let run;
	try {
		run = requestRun
			? await requestRun({ period, trigger: "freshness", origin })
			: await import("./period-digest-orchestrator").then(
					({ requestPeriodDigestRun }) =>
						requestPeriodDigestRun({ period, trigger: "freshness", origin }),
				);
	} catch (error) {
		await reportFailedAttempt().catch(() => undefined);
		throw error;
	}
	void run.completion
		.then(
			(finalState) =>
				completeAttempt({
					period,
					attemptToken: state.attemptToken,
					origin,
					outcome: finalState.phase === "failed" ? "failed" : "published",
				}),
			() => reportFailedAttempt(),
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
	deferLaunchAgentReload = false,
	replaceRunningAttempt = false,
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
	deferLaunchAgentReload?: boolean;
	replaceRunningAttempt?: boolean;
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
	const sameAttempt = previous?.attemptToken === attemptToken;
	const replacingRunningAttempt = Boolean(
		previous?.status === "running" && replaceRunningAttempt && !sameAttempt,
	);
	if (previous?.status === "running" && !replacingRunningAttempt) {
		const leaseActive =
			now.getTime() < runningLeaseEligibleAt(previous).getTime();
		if (leaseActive || (await isPeriodDigestRunActive(period))) {
			return { state: previous, installResult: null };
		}
	}
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
		sameAttempt &&
		(previous.status === "retryable" ||
			previous.status === "failed" ||
			previous.status === "consumed")
	) {
		return { state: previous, installResult: null };
	}
	const restoringRetry =
		sameAttempt && previous.status === "error" && Boolean(previous.retryAt);
	const desiredFireAt =
		restoringRetry && previous.retryAt ? new Date(previous.retryAt) : dueAt;
	const fireAt = resolveLaunchAgentFireAt(desiredFireAt, now);
	const retainedAttemptFields = {
		...(sameAttempt && previous.retryCount !== undefined
			? { retryCount: previous.retryCount }
			: {}),
		...(restoringRetry && previous.retryAt
			? { retryAt: previous.retryAt }
			: {}),
		...(sameAttempt && previous.pageRecoveryUsedAt
			? { pageRecoveryUsedAt: previous.pageRecoveryUsedAt }
			: {}),
	};
	if (!fireAt) {
		const disabled: PeriodDigestFreshnessStateV1 = {
			schemaVersion: 1,
			period,
			attemptToken,
			dueAt: dueAt.toISOString(),
			fireAt: "",
			status: "disabled",
			updatedAt: now.toISOString(),
			freshnessSeconds,
			sourceIdentities,
			suppressedSourceIdentities,
			...retainedAttemptFields,
		};
		await writePeriodDigestFreshnessState(disabled);
		return { state: disabled, installResult: null };
	}
	const state: PeriodDigestFreshnessStateV1 = {
		schemaVersion: 1,
		period,
		attemptToken,
		dueAt: dueAt.toISOString(),
		fireAt: fireAt.toISOString(),
		status: restoringRetry ? "retryable" : "scheduled",
		updatedAt: now.toISOString(),
		freshnessSeconds,
		sourceIdentities,
		suppressedSourceIdentities,
		...retainedAttemptFields,
	};
	await writePeriodDigestFreshnessState(state);
	const execution = resolveDigestLaunchdExecution();
	const launchdCallerPid = validProcessId(previous?.launchdCallerPid)
		? previous.launchdCallerPid
		: undefined;
	const shouldDeferLaunchAgentReload =
		deferLaunchAgentReload ||
		(replacingRunningAttempt && launchdCallerPid !== undefined);
	const agent = shouldDeferLaunchAgentReload
		? buildPeriodDigestFreshnessRetryReloaderLaunchAgent({
				period,
				attemptToken,
				parentPid: launchdCallerPid,
				program: program ?? execution.program,
				envFile: envFile ?? execution.envFile,
				launchAgentsDir: installOptions?.launchAgentsDir,
			})
		: buildPeriodDigestFreshnessLaunchAgent({
				period,
				fireAt,
				attemptToken,
				program: program ?? execution.program,
				envFile: envFile ?? execution.envFile,
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
