import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getBirdCredentialsPath } from "./bird-credentials";
import {
	getBirdclawPaths,
	resolveDigestFreshnessSeconds,
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

export interface PeriodDigestFreshnessStateV1 {
	schemaVersion: 1;
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	dueAt: string;
	fireAt: string;
	status: "scheduled" | "consumed" | "disabled" | "error";
	updatedAt: string;
	consumedAt?: string;
	installError?: string;
}

export interface CalculateFreshnessDeadlineInput {
	now: Date;
	freshnessSeconds: number;
	schedule: Required<Pick<DigestScheduleTime, "hour" | "minute">>;
	generatedAt: Partial<Record<PeriodDigestContentSource, string>>;
}

const CONTENT_SOURCES: PeriodDigestContentSource[] = [
	"all",
	"following",
	"for_you",
];
const stateQueues = new Map<string, Promise<void>>();
const reconcileQueues = new Map<CurrentPeriodDigestPeriod, Promise<void>>();

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
}: CalculateFreshnessDeadlineInput) {
	const scheduledBase = new Date(now);
	scheduledBase.setHours(schedule.hour, schedule.minute, 0, 0);
	const candidates = CONTENT_SOURCES.map((contentSource) => {
		const generated = new Date(generatedAt[contentSource] ?? "");
		const base =
			Number.isFinite(generated.getTime()) && sameLocalDay(generated, now)
				? generated
				: scheduledBase;
		return new Date(base.getTime() + freshnessSeconds * 1_000);
	});
	const deadline = new Date(
		Math.min(...candidates.map((candidate) => candidate.getTime())),
	);
	return sameLocalDay(deadline, now) ? deadline : null;
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
	dueAt,
	attemptToken,
	program = "birdclaw",
}: {
	period: CurrentPeriodDigestPeriod;
	dueAt: Date;
	attemptToken: string;
	program?: string;
}): LaunchAgent {
	const fireAt = roundUpToMinute(dueAt);
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
	});
}

export async function consumePeriodDigestFreshnessAttempt({
	period,
	attemptToken,
	now = new Date(),
}: {
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	now?: Date;
}): Promise<
	| { valid: true }
	| {
			valid: false;
			reason:
				| "missing-state"
				| "token-mismatch"
				| "already-consumed"
				| "not-due"
				| "cross-day";
	  }
> {
	const statePath = periodDigestFreshnessStatePath(period);
	return serializeState(statePath, async () => {
		const state = await readPeriodDigestFreshnessState(period);
		if (!state) return { valid: false, reason: "missing-state" } as const;
		if (state.attemptToken !== attemptToken) {
			return { valid: false, reason: "token-mismatch" } as const;
		}
		if (state.status === "consumed") {
			return { valid: false, reason: "already-consumed" } as const;
		}
		const dueAt = new Date(state.dueAt);
		if (!sameLocalDay(dueAt, now)) {
			return { valid: false, reason: "cross-day" } as const;
		}
		if (now.getTime() < dueAt.getTime()) {
			return { valid: false, reason: "not-due" } as const;
		}
		await writeStateFile(statePath, {
			...state,
			status: "consumed",
			consumedAt: now.toISOString(),
			updatedAt: now.toISOString(),
		});
		return { valid: true } as const;
	});
}

export async function triggerDuePeriodDigestFreshness({
	period,
	origin,
	now = new Date(),
	requestRun,
}: {
	period: CurrentPeriodDigestPeriod;
	origin: "page" | "cli";
	now?: Date;
	requestRun?: (request: {
		period: CurrentPeriodDigestPeriod;
		trigger: "freshness";
		origin: "page" | "cli";
	}) => Promise<{ runId: string; joined: boolean }>;
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
}) {
	const generatedAt = Object.fromEntries(
		CONTENT_SOURCES.flatMap((contentSource) => {
			const current = readCurrentPeriodDigest(period, contentSource);
			return current ? [[contentSource, current.generatedAt]] : [];
		}),
	) as Partial<Record<PeriodDigestContentSource, string>>;
	const dueAt = calculatePeriodDigestFreshnessDeadline({
		now,
		freshnessSeconds,
		schedule,
		generatedAt,
	});
	const attemptToken = randomUUID();
	if (!dueAt) {
		const state: PeriodDigestFreshnessStateV1 = {
			schemaVersion: 1,
			period,
			attemptToken,
			dueAt: "",
			fireAt: "",
			status: "disabled",
			updatedAt: now.toISOString(),
		};
		await writePeriodDigestFreshnessState(state);
		return { state, installResult: null };
	}
	const fireAt = roundUpToMinute(
		dueAt.getTime() <= now.getTime() ? new Date(now.getTime() + 1) : dueAt,
	);
	const state: PeriodDigestFreshnessStateV1 = {
		schemaVersion: 1,
		period,
		attemptToken,
		dueAt: dueAt.toISOString(),
		fireAt: fireAt.toISOString(),
		status: "scheduled",
		updatedAt: now.toISOString(),
	};
	await writePeriodDigestFreshnessState(state);
	const agent = buildPeriodDigestFreshnessLaunchAgent({
		period,
		dueAt: fireAt,
		attemptToken,
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
		reconcilePeriodDigestFreshnessInternal(input),
	);
}

export async function reconcileAllPeriodDigestFreshness() {
	const [today, hour24] = await Promise.all([
		reconcilePeriodDigestFreshness({ period: "today" }),
		reconcilePeriodDigestFreshness({ period: "24h" }),
	]);
	return { today, "24h": hour24 };
}
