import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
	getBirdCredentialsPath,
	readBirdCredentialsFileStrict,
	type BirdCredentials,
} from "./bird-credentials";
import { getBirdclawPaths } from "./config";
import {
	runDigestArchivePreSyncEffect,
	type DigestArchiveSyncResult,
} from "./digest-archive-sync";
import {
	collectPeriodDigestContext,
	generatePeriodDigestFromContextEffect,
	resolvePeriodDigestWindow,
	selectPeriodDigestLanguage,
	type PeriodDigestContentSource,
	type PeriodDigestContext,
	type PeriodDigestRunResult,
} from "./period-digest";
import {
	publishCurrentPeriodDigest,
	type CurrentPeriodDigestPeriod,
	type PublishCurrentPeriodDigestInput,
} from "./period-digest-current-store";
import { resolveEffectivePrompt } from "./prompt-templates";
import { resolveUserPath } from "./launchd";
import {
	acquireScheduledJobLock,
	appendScheduledJobAudit,
	type ScheduledJobLockRelease,
} from "./scheduled-job";
import { sensitiveErrorMessage } from "./sensitive-values";
import type { Database } from "./sqlite";

export type PeriodDigestTrigger = "scheduled" | "freshness" | "manual";
export type PeriodDigestTriggerOrigin = "launchd" | "page" | "cli";
export type PeriodDigestRunPhase =
	| "syncing"
	| "preparing"
	| "generating"
	| "completed"
	| "degraded"
	| "failed";

export interface PeriodDigestTriggerEvent {
	trigger: PeriodDigestTrigger;
	origin: PeriodDigestTriggerOrigin;
}

export interface PeriodDigestJoinedTriggerEvent extends PeriodDigestTriggerEvent {
	at: string;
}

export interface PeriodDigestSourceRunState {
	state: "pending" | "running" | "completed" | "failed";
	attempts: number;
	generatedAt?: string;
	versionId?: string;
	error?: string;
}

export interface PeriodDigestRunStateV1 {
	schemaVersion: 1;
	runId: string;
	period: CurrentPeriodDigestPeriod;
	startedBy: PeriodDigestTriggerEvent;
	joinedBy: PeriodDigestJoinedTriggerEvent[];
	prioritySource?: PeriodDigestContentSource;
	sourceOrder: PeriodDigestContentSource[];
	ownerId: string;
	pid: number;
	host: string;
	startedAt: string;
	heartbeatAt: string;
	phase: PeriodDigestRunPhase;
	currentSource?: PeriodDigestContentSource;
	sources: Record<PeriodDigestContentSource, PeriodDigestSourceRunState>;
	sync?: DigestArchiveSyncResult;
	error?: string;
	finishedAt?: string;
}

export interface PeriodDigestRunRequest extends PeriodDigestTriggerEvent {
	period: CurrentPeriodDigestPeriod;
	requestedSource?: PeriodDigestContentSource;
	account?: string;
	liveSync?: boolean;
	language?: string;
	birdCredentialsPath?: string;
}

export interface PeriodDigestGenerateInput {
	period: CurrentPeriodDigestPeriod;
	contentSource: PeriodDigestContentSource;
	context: PeriodDigestContext;
	account?: string;
	since: string;
	until: string;
	language?: string;
	signal?: AbortSignal;
}

export interface PeriodDigestOrchestratorDependencies {
	now(): Date;
	randomId(): string;
	preSync(input: {
		period: CurrentPeriodDigestPeriod;
		contentSources: PeriodDigestContentSource[];
		account?: string;
		since: string;
		until: string;
		liveSync: boolean;
		birdCredentials?: BirdCredentials | null;
	}): Promise<DigestArchiveSyncResult>;
	collectContext(input: {
		period: CurrentPeriodDigestPeriod;
		contentSource: PeriodDigestContentSource;
		account?: string;
		since: string;
		until: string;
	}): PeriodDigestContext;
	generate(input: PeriodDigestGenerateInput): Promise<PeriodDigestRunResult>;
	readCredentials(path: string): BirdCredentials;
	publish?(input: PublishCurrentPeriodDigestInput, database?: Database): void;
	reconcileFreshness?(period: CurrentPeriodDigestPeriod): Promise<unknown>;
	audit?(state: PeriodDigestRunStateV1): Promise<unknown>;
	sleep?(milliseconds: number): Promise<void>;
	database?: Database;
	heartbeatIntervalMs?: number;
	lockStaleMs?: number;
	maxGenerateAttempts?: number;
	retryDelayMs?: number;
	modelTimeoutMs?: number;
}

export interface PeriodDigestRunRequestResult {
	runId: string;
	joined: boolean;
	completion: Promise<PeriodDigestRunStateV1>;
}

const DEFAULT_SOURCE_ORDER: PeriodDigestContentSource[] = [
	"all",
	"following",
	"for_you",
];
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_GENERATE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 120_000;
const DEFAULT_MODEL_TIMEOUT_MS = 10 * 60_000;
export const PERIOD_DIGEST_LOCK_STALE_MS = 60_000;
const MAX_RUN_AGE_MS = 6 * 60 * 60_000;
const MAX_TWEETS = 5_000;
const MAX_LINKS = 20;
const stateMutationQueues = new Map<string, Promise<void>>();

function serializeStateMutation<T>(
	statePath: string,
	mutation: () => Promise<T>,
) {
	const previous = stateMutationQueues.get(statePath) ?? Promise.resolve();
	const operation = previous.then(mutation);
	const tail = operation.then(
		() => undefined,
		() => undefined,
	);
	stateMutationQueues.set(statePath, tail);
	return operation.finally(() => {
		if (stateMutationQueues.get(statePath) === tail) {
			stateMutationQueues.delete(statePath);
		}
	});
}

export function periodDigestRunStatePath(period: CurrentPeriodDigestPeriod) {
	return path.join(
		getBirdclawPaths().rootDir,
		"runs",
		`period-digest-${period}.json`,
	);
}

export function periodDigestRunLockPath(period: CurrentPeriodDigestPeriod) {
	return path.join(
		getBirdclawPaths().rootDir,
		"locks",
		`period-digest-${period}.lock`,
	);
}

function isContentSource(value: unknown): value is PeriodDigestContentSource {
	return value === "all" || value === "following" || value === "for_you";
}

function isTrigger(value: unknown): value is PeriodDigestTrigger {
	return value === "scheduled" || value === "freshness" || value === "manual";
}

function isOrigin(value: unknown): value is PeriodDigestTriggerOrigin {
	return value === "launchd" || value === "page" || value === "cli";
}

function parseRunState(value: unknown): PeriodDigestRunStateV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const state = value as Partial<PeriodDigestRunStateV1>;
	if (
		state.schemaVersion !== 1 ||
		typeof state.runId !== "string" ||
		(state.period !== "today" && state.period !== "24h") ||
		!state.startedBy ||
		!isTrigger(state.startedBy.trigger) ||
		!isOrigin(state.startedBy.origin) ||
		!Array.isArray(state.joinedBy) ||
		!Array.isArray(state.sourceOrder) ||
		!state.sourceOrder.every(isContentSource) ||
		typeof state.ownerId !== "string" ||
		typeof state.pid !== "number" ||
		typeof state.host !== "string" ||
		typeof state.startedAt !== "string" ||
		typeof state.heartbeatAt !== "string" ||
		typeof state.phase !== "string" ||
		!state.sources ||
		typeof state.sources !== "object"
	) {
		return undefined;
	}
	return state as PeriodDigestRunStateV1;
}

async function readRunStateFile(statePath: string) {
	const raw = await fs.readFile(statePath, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	try {
		return parseRunState(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

export function readPeriodDigestRunState(period: CurrentPeriodDigestPeriod) {
	return readRunStateFile(periodDigestRunStatePath(period));
}

async function writeRunStateFile(
	statePath: string,
	state: PeriodDigestRunStateV1,
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

function writeRunState(statePath: string, state: PeriodDigestRunStateV1) {
	return serializeStateMutation(statePath, () =>
		writeRunStateFile(statePath, state),
	);
}

function updateOwnedRunState(
	statePath: string,
	ownerId: string,
	update: (state: PeriodDigestRunStateV1) => PeriodDigestRunStateV1,
	now: Date,
) {
	return serializeStateMutation(statePath, async () => {
		const current = await readRunStateFile(statePath);
		if (!current || current.ownerId !== ownerId) return undefined;
		const next = {
			...update(current),
			ownerId,
			heartbeatAt: now.toISOString(),
		};
		await writeRunStateFile(statePath, next);
		return next;
	});
}

async function recordJoinedTrigger(
	statePath: string,
	runId: string,
	event: PeriodDigestTriggerEvent,
	now: Date,
) {
	return serializeStateMutation(statePath, async () => {
		const current = await readRunStateFile(statePath);
		if (!current || current.runId !== runId) return current;
		const next = {
			...current,
			joinedBy: [...current.joinedBy, { ...event, at: now.toISOString() }],
		};
		await writeRunStateFile(statePath, next);
		return next;
	});
}

function sourceOrder(request: PeriodDigestRunRequest) {
	if (request.trigger !== "manual" || !request.requestedSource) {
		return [...DEFAULT_SOURCE_ORDER];
	}
	return [
		request.requestedSource,
		...DEFAULT_SOURCE_ORDER.filter(
			(contentSource) => contentSource !== request.requestedSource,
		),
	];
}

function createInitialState(
	request: PeriodDigestRunRequest,
	ownerId: string,
	runId: string,
	now: Date,
): PeriodDigestRunStateV1 {
	const timestamp = now.toISOString();
	const order = sourceOrder(request);
	return {
		schemaVersion: 1,
		runId,
		period: request.period,
		startedBy: { trigger: request.trigger, origin: request.origin },
		joinedBy: [],
		...(request.trigger === "manual" && request.requestedSource
			? { prioritySource: request.requestedSource }
			: {}),
		sourceOrder: order,
		ownerId,
		pid: process.pid,
		host: os.hostname(),
		startedAt: timestamp,
		heartbeatAt: timestamp,
		phase: "syncing",
		sources: Object.fromEntries(
			DEFAULT_SOURCE_ORDER.map((contentSource) => [
				contentSource,
				{ state: "pending", attempts: 0 },
			]),
		) as Record<PeriodDigestContentSource, PeriodDigestSourceRunState>,
	};
}

function defaultDependencies(): PeriodDigestOrchestratorDependencies {
	return {
		now: () => new Date(),
		randomId: randomUUID,
		preSync: (input) =>
			Effect.runPromise(
				runDigestArchivePreSyncEffect({
					...input,
					nonInteractiveBird: true,
				}),
			),
		collectContext: (input) =>
			collectPeriodDigestContext({
				...input,
				includeDms: false,
				maxTweets: MAX_TWEETS,
				maxLinks: MAX_LINKS,
				liveSync: false,
			}),
		generate: (input) =>
			Effect.runPromise(
				generatePeriodDigestFromContextEffect(input.context, {
					period: input.period,
					contentSource: input.contentSource,
					account: input.account,
					includeDms: false,
					since: input.since,
					until: input.until,
					language: input.language,
					maxTweets: MAX_TWEETS,
					maxLinks: MAX_LINKS,
					liveSync: false,
					refresh: true,
					signal: input.signal,
				}),
			),
		readCredentials: (credentialsPath) => {
			const credentials = readBirdCredentialsFileStrict(credentialsPath);
			if (!credentials) {
				throw new Error(
					"Bird credentials are not configured for background digest sync",
				);
			}
			return credentials;
		},
		reconcileFreshness: async (period) => {
			const { reconcilePeriodDigestFreshness } =
				await import("./period-digest-freshness");
			return reconcilePeriodDigestFreshness({ period });
		},
		audit: (state) =>
			appendScheduledJobAudit(
				path.join(getBirdclawPaths().rootDir, "logs", "period-digest.jsonl"),
				state,
			),
		sleep: (milliseconds) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)),
	};
}

async function waitForActiveRunState(statePath: string) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const state = await readRunStateFile(statePath);
		if (state && !["completed", "degraded", "failed"].includes(state.phase)) {
			return state;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return undefined;
}

async function waitForRunCompletion(
	statePath: string,
	runId: string,
): Promise<PeriodDigestRunStateV1> {
	for (;;) {
		const state = await readRunStateFile(statePath);
		if (
			state?.runId === runId &&
			["completed", "degraded", "failed"].includes(state.phase)
		) {
			return state;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

async function runOwnedBatch({
	request,
	statePath,
	state,
	releaseLock,
	dependencies,
}: {
	request: PeriodDigestRunRequest;
	statePath: string;
	state: PeriodDigestRunStateV1;
	releaseLock: ScheduledJobLockRelease;
	dependencies: PeriodDigestOrchestratorDependencies;
}): Promise<PeriodDigestRunStateV1> {
	const ownerId = state.ownerId;
	const heartbeat = setInterval(() => {
		void updateOwnedRunState(
			statePath,
			ownerId,
			(current) => current,
			dependencies.now(),
		).then(() => releaseLock.heartbeat());
	}, dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
	heartbeat.unref?.();
	let completedSources = 0;
	let sync: DigestArchiveSyncResult = { status: "skipped", steps: [] };
	try {
		const window = resolvePeriodDigestWindow({
			period: request.period,
			now: dependencies.now(),
		});
		const liveSync = request.liveSync ?? true;
		const birdCredentials = liveSync
			? dependencies.readCredentials(
					resolveUserPath(
						request.birdCredentialsPath ?? getBirdCredentialsPath(),
					),
				)
			: undefined;
		sync = await dependencies.preSync({
			period: request.period,
			contentSources: [...DEFAULT_SOURCE_ORDER],
			...(request.account ? { account: request.account } : {}),
			since: window.since,
			until: window.until,
			liveSync,
			...(birdCredentials !== undefined ? { birdCredentials } : {}),
		});
		await updateOwnedRunState(
			statePath,
			ownerId,
			(current) => ({ ...current, phase: "preparing", sync }),
			dependencies.now(),
		);
		const contexts = new Map<PeriodDigestContentSource, PeriodDigestContext>();
		for (const contentSource of DEFAULT_SOURCE_ORDER) {
			contexts.set(
				contentSource,
				dependencies.collectContext({
					period: request.period,
					contentSource,
					...(request.account ? { account: request.account } : {}),
					since: window.since,
					until: window.until,
				}),
			);
		}
		const language = request.language ?? selectPeriodDigestLanguage();
		const promptHash = resolveEffectivePrompt("period-digest").promptHash;
		for (const contentSource of state.sourceOrder) {
			const maxAttempts = Math.max(
				1,
				dependencies.maxGenerateAttempts ?? DEFAULT_MAX_GENERATE_ATTEMPTS,
			);
			let generated: PeriodDigestRunResult | undefined;
			let generationError: unknown;
			let attempts = 0;
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				attempts = attempt;
				await updateOwnedRunState(
					statePath,
					ownerId,
					(current) => ({
						...current,
						phase: "generating",
						currentSource: contentSource,
						sources: {
							...current.sources,
							[contentSource]: { state: "running", attempts: attempt },
						},
					}),
					dependencies.now(),
				);
				try {
					const context = contexts.get(contentSource);
					if (!context) {
						throw new Error(`Missing frozen ${contentSource} context`);
					}
					generated = await dependencies.generate({
						period: request.period,
						contentSource,
						context,
						...(request.account ? { account: request.account } : {}),
						since: window.since,
						until: window.until,
						...(language ? { language } : {}),
						signal: AbortSignal.timeout(
							dependencies.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
						),
					});
					generationError = undefined;
					break;
				} catch (error) {
					generationError = error;
					if (attempt < maxAttempts) {
						await (dependencies.sleep ?? defaultDependencies().sleep)?.(
							dependencies.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
						);
					}
				}
			}
			try {
				if (!generated) throw generationError;
				const context = contexts.get(contentSource);
				if (!context)
					throw new Error(`Missing frozen ${contentSource} context`);
				if (!(await releaseLock.heartbeat())) {
					throw new Error("Period digest lease ownership was lost");
				}
				const versionId = dependencies.randomId();
				(dependencies.publish ?? publishCurrentPeriodDigest)(
					{
						period: request.period,
						contentSource,
						runId: state.runId,
						versionId,
						generatedAt: generated.updatedAt,
						result: generated,
						...(language ? { language } : {}),
						promptHash,
						maxTweets: MAX_TWEETS,
						maxLinks: MAX_LINKS,
						sync,
					},
					dependencies.database,
				);
				completedSources += 1;
				await updateOwnedRunState(
					statePath,
					ownerId,
					(current) => ({
						...current,
						sources: {
							...current.sources,
							[contentSource]: {
								state: "completed",
								attempts,
								generatedAt: generated.updatedAt,
								versionId,
							},
						},
					}),
					dependencies.now(),
				);
			} catch (error) {
				await updateOwnedRunState(
					statePath,
					ownerId,
					(current) => ({
						...current,
						sources: {
							...current.sources,
							[contentSource]: {
								state: "failed",
								attempts,
								error: sensitiveErrorMessage(error),
							},
						},
					}),
					dependencies.now(),
				);
			}
		}
		const phase: PeriodDigestRunPhase =
			completedSources === 0
				? "failed"
				: completedSources < DEFAULT_SOURCE_ORDER.length ||
					  sync.status === "degraded"
					? "degraded"
					: "completed";
		const finalState = await updateOwnedRunState(
			statePath,
			ownerId,
			(current) => ({
				...current,
				phase,
				currentSource: undefined,
				finishedAt: dependencies.now().toISOString(),
			}),
			dependencies.now(),
		);
		if (!finalState) throw new Error("Period digest run ownership was lost");
		if (
			Object.values(finalState.sources).every(
				(source) => source.state === "completed",
			)
		) {
			await dependencies
				.reconcileFreshness?.(request.period)
				.catch(() => undefined);
		}
		await dependencies.audit?.(finalState).catch(() => undefined);
		return finalState;
	} catch (error) {
		const failed = await updateOwnedRunState(
			statePath,
			ownerId,
			(current) => ({
				...current,
				phase: "failed",
				currentSource: undefined,
				sync,
				error: sensitiveErrorMessage(error),
				finishedAt: dependencies.now().toISOString(),
			}),
			dependencies.now(),
		);
		if (failed) {
			await dependencies.audit?.(failed).catch(() => undefined);
			return failed;
		}
		throw error;
	} finally {
		clearInterval(heartbeat);
		await releaseLock();
	}
}

export async function requestPeriodDigestRun(
	request: PeriodDigestRunRequest,
	dependencyOverrides: Partial<PeriodDigestOrchestratorDependencies> = {},
): Promise<PeriodDigestRunRequestResult> {
	if (request.trigger !== "manual" && request.requestedSource) {
		throw new Error("requestedSource is only valid for manual digest runs");
	}
	const dependencies = {
		...defaultDependencies(),
		...dependencyOverrides,
	} satisfies PeriodDigestOrchestratorDependencies;
	const statePath = periodDigestRunStatePath(request.period);
	const releaseLock = await acquireScheduledJobLock(
		periodDigestRunLockPath(request.period),
		dependencies.lockStaleMs ?? PERIOD_DIGEST_LOCK_STALE_MS,
		{ totalSources: DEFAULT_SOURCE_ORDER.length },
		MAX_RUN_AGE_MS,
	);
	if (!releaseLock) {
		const active = await waitForActiveRunState(statePath);
		if (!active) {
			throw new Error(
				"Period digest is locked but its run state is unavailable",
			);
		}
		await recordJoinedTrigger(
			statePath,
			active.runId,
			{ trigger: request.trigger, origin: request.origin },
			dependencies.now(),
		);
		return {
			runId: active.runId,
			joined: true,
			completion: waitForRunCompletion(statePath, active.runId),
		};
	}

	const state = createInitialState(
		request,
		dependencies.randomId(),
		dependencies.randomId(),
		dependencies.now(),
	);
	await writeRunState(statePath, state);
	const completion = runOwnedBatch({
		request,
		statePath,
		state,
		releaseLock,
		dependencies,
	});
	void completion.catch(() => undefined);
	return { runId: state.runId, joined: false, completion };
}
