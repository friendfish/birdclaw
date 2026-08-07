import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
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
	openAIStreamDiagnosticsFromError,
	sanitizeOpenAIStreamDiagnostics,
	type OpenAIStreamDiagnostics,
} from "./openai-response-runtime";
import {
	collectPeriodDigestContext,
	generatePeriodDigestFromContextEffect,
	resolvePeriodDigestWindow,
	selectPeriodDigestLanguage,
	type PeriodDigestContentSource,
	type PeriodDigestContext,
	type PeriodDigestRunResult,
} from "./period-digest";
import { assertDisplayablePeriodDigest } from "./period-digest-integrity";
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
	peekScheduledJobLockMetadata,
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
	diagnostics?: OpenAIStreamDiagnostics;
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
	reconcileFreshness?(
		period: CurrentPeriodDigestPeriod,
		options?: { suppressSources: PeriodDigestContentSource[] },
	): Promise<unknown>;
	audit?(state: PeriodDigestRunStateV1): Promise<unknown>;
	sleep?(milliseconds: number): Promise<void>;
	database?: Database;
	heartbeatIntervalMs?: number;
	lockStaleMs?: number;
	maxGenerateAttempts?: number;
	retryDelayMs?: number;
	modelTimeoutMs?: number;
	completionWaitTimeoutMs?: number;
	completionPollIntervalMs?: number;
	stateReadyTimeoutMs?: number;
	lockAcquisitionTimeoutMs?: number;
	lockRetryDelayMs?: number;
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
const DEFAULT_COMPLETION_POLL_INTERVAL_MS = 250;
const DEFAULT_STATE_READY_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 25;
const MAX_RETAINED_JOIN_EVENT_RUNS = 32;
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

function periodDigestJoinEventsDir(
	period: CurrentPeriodDigestPeriod,
	runId: string,
) {
	return path.join(periodDigestJoinEventsRoot(period), runId);
}

function periodDigestJoinEventsRoot(period: CurrentPeriodDigestPeriod) {
	return path.join(
		getBirdclawPaths().rootDir,
		"runs",
		"period-digest-joins",
		period,
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

async function readJoinedTriggers(
	period: CurrentPeriodDigestPeriod,
	runId: string,
) {
	const directory = periodDigestJoinEventsDir(period, runId);
	const names = await fs.readdir(directory).catch(() => [] as string[]);
	const events = await Promise.all(
		names.map(async (name) => {
			const raw = await fs
				.readFile(path.join(directory, name), "utf8")
				.catch(() => undefined);
			if (raw === undefined) return undefined;
			try {
				const event = JSON.parse(
					raw,
				) as Partial<PeriodDigestJoinedTriggerEvent>;
				return isTrigger(event.trigger) &&
					isOrigin(event.origin) &&
					typeof event.at === "string"
					? (event as PeriodDigestJoinedTriggerEvent)
					: undefined;
			} catch {
				return undefined;
			}
		}),
	);
	return events
		.filter(
			(event): event is PeriodDigestJoinedTriggerEvent => event !== undefined,
		)
		.sort((left, right) => left.at.localeCompare(right.at));
}

function joinedTriggerKey(event: PeriodDigestJoinedTriggerEvent) {
	return `${event.trigger}:${event.origin}:${event.at}`;
}

async function withJoinedTriggers(state: PeriodDigestRunStateV1) {
	const joinedBy = await readJoinedTriggers(state.period, state.runId);
	const unique = new Map(
		[...state.joinedBy, ...joinedBy].map((event) => [
			joinedTriggerKey(event),
			event,
		]),
	);
	return {
		...state,
		joinedBy: [...unique.values()].sort((left, right) =>
			left.at.localeCompare(right.at),
		),
	};
}

export async function readPeriodDigestRunState(
	period: CurrentPeriodDigestPeriod,
) {
	const state = await readRunStateFile(periodDigestRunStatePath(period));
	return state ? withJoinedTriggers(state) : undefined;
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
	period: CurrentPeriodDigestPeriod,
	runId: string,
	event: PeriodDigestTriggerEvent,
	now: Date,
) {
	const directory = periodDigestJoinEventsDir(period, runId);
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(
		path.join(directory, `${process.pid}-${randomUUID()}.json`),
		`${JSON.stringify({ ...event, at: now.toISOString() })}\n`,
		{ encoding: "utf8", flag: "wx" },
	);
}

async function cleanupJoinedTriggerEvents(
	period: CurrentPeriodDigestPeriod,
	currentRunId: string,
) {
	const root = periodDigestJoinEventsRoot(period);
	const entries = await fs
		.readdir(root, { withFileTypes: true })
		.catch(() => [] as Dirent[]);
	const directories = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => ({
				name: entry.name,
				mtimeMs: await fs
					.stat(path.join(root, entry.name))
					.then((stat) => stat.mtimeMs)
					.catch(() => 0),
			})),
	);
	directories.sort((left, right) => right.mtimeMs - left.mtimeMs);
	const retained = new Set<string>();
	if (directories.some(({ name }) => name === currentRunId)) {
		retained.add(currentRunId);
	}
	for (const directory of directories) {
		if (retained.size >= MAX_RETAINED_JOIN_EVENT_RUNS) break;
		retained.add(directory.name);
	}
	await Promise.all(
		directories
			.filter(({ name }) => !retained.has(name))
			.map(({ name }) =>
				fs.rm(path.join(root, name), { recursive: true, force: true }),
			),
	);
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

function defaultSleep(milliseconds: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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
		reconcileFreshness: async (period, options) => {
			const { reconcilePeriodDigestFreshness } =
				await import("./period-digest-freshness");
			return reconcilePeriodDigestFreshness({ period, ...options });
		},
		audit: (state) =>
			appendScheduledJobAudit(
				path.join(getBirdclawPaths().rootDir, "logs", "period-digest.jsonl"),
				state,
			),
		sleep: defaultSleep,
	};
}

async function waitForJoinableRunState({
	statePath,
	lockPath,
	lockStaleMs,
	timeoutMs,
	pollIntervalMs,
}: {
	statePath: string;
	lockPath: string;
	lockStaleMs: number;
	timeoutMs: number;
	pollIntervalMs: number;
}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const [state, lock] = await Promise.all([
			readRunStateFile(statePath),
			peekScheduledJobLockMetadata(lockPath, lockStaleMs, MAX_RUN_AGE_MS),
		]);
		if (!lock) return undefined;
		if (state && (!lock.ownerId || state.ownerId === lock.ownerId))
			return state;
		if (Date.now() >= deadline) {
			throw new Error(
				"Period digest is locked but its run state is unavailable",
			);
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

async function waitForRunCompletion(
	statePath: string,
	lockPath: string,
	runId: string,
	lockStaleMs: number,
	timeoutMs: number,
	pollIntervalMs: number,
): Promise<PeriodDigestRunStateV1> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const state = await readRunStateFile(statePath);
		if (state && state.runId !== runId) {
			throw new Error(
				`Period digest run ${runId} was superseded by ${state.runId}`,
			);
		}
		if (state && ["completed", "degraded", "failed"].includes(state.phase)) {
			return withJoinedTriggers(state);
		}
		const lock = await peekScheduledJobLockMetadata(
			lockPath,
			lockStaleMs,
			MAX_RUN_AGE_MS,
		);
		if (!lock) {
			throw new Error(`Period digest run ${runId} lost its active owner`);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Period digest run ${runId} did not complete within ${String(timeoutMs)}ms`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

class PeriodDigestOwnershipLostError extends Error {
	constructor(cause?: unknown) {
		super("Period digest lease ownership was lost", { cause });
		this.name = "PeriodDigestOwnershipLostError";
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
	const ownerAbort = new AbortController();
	let ownershipError: PeriodDigestOwnershipLostError | undefined;
	const loseOwnership = (cause?: unknown) => {
		if (ownershipError) return ownershipError;
		ownershipError = new PeriodDigestOwnershipLostError(cause);
		ownerAbort.abort(ownershipError);
		return ownershipError;
	};
	const throwIfOwnershipLost = () => {
		if (ownershipError) throw ownershipError;
	};
	let heartbeatTask = Promise.resolve();
	const heartbeat = setInterval(() => {
		heartbeatTask = heartbeatTask
			.then(async () => {
				if (ownerAbort.signal.aborted) return;
				const updated = await updateOwnedRunState(
					statePath,
					ownerId,
					(current) => current,
					dependencies.now(),
				);
				if (!updated || !(await releaseLock.heartbeat())) {
					throw new PeriodDigestOwnershipLostError();
				}
			})
			.catch((error) => {
				loseOwnership(error);
			});
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
			throwIfOwnershipLost();
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
					const candidate = await dependencies.generate({
						period: request.period,
						contentSource,
						context,
						...(request.account ? { account: request.account } : {}),
						since: window.since,
						until: window.until,
						...(language ? { language } : {}),
						signal: AbortSignal.any([
							ownerAbort.signal,
							AbortSignal.timeout(
								dependencies.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
							),
						]),
					});
					assertDisplayablePeriodDigest(candidate);
					generated = candidate;
					generationError = undefined;
					break;
				} catch (error) {
					throwIfOwnershipLost();
					generationError = error;
					if (attempt < maxAttempts) {
						await (dependencies.sleep ?? defaultSleep)(
							dependencies.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
						);
					}
				}
			}
			try {
				throwIfOwnershipLost();
				if (!generated) throw generationError;
				const context = contexts.get(contentSource);
				if (!context)
					throw new Error(`Missing frozen ${contentSource} context`);
				if (!(await releaseLock.heartbeat())) {
					throw loseOwnership();
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
				const diagnostics = sanitizeOpenAIStreamDiagnostics(
					generated.diagnostics,
				);
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
								...(diagnostics ? { diagnostics } : {}),
							},
						},
					}),
					dependencies.now(),
				);
			} catch (error) {
				throwIfOwnershipLost();
				const diagnostics = sanitizeOpenAIStreamDiagnostics(
					openAIStreamDiagnosticsFromError(error),
				);
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
								...(diagnostics ? { diagnostics } : {}),
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
		if (completedSources > 0) {
			const suppressSources = DEFAULT_SOURCE_ORDER.filter(
				(contentSource) => finalState.sources[contentSource].state === "failed",
			);
			const reconciliation =
				suppressSources.length > 0
					? dependencies.reconcileFreshness?.(request.period, {
							suppressSources,
						})
					: dependencies.reconcileFreshness?.(request.period);
			await reconciliation?.catch(() => undefined);
		}
		const observedFinalState = await withJoinedTriggers(finalState);
		await dependencies.audit?.(observedFinalState).catch(() => undefined);
		return observedFinalState;
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
			const observedFailed = await withJoinedTriggers(failed);
			await dependencies.audit?.(observedFailed).catch(() => undefined);
			return observedFailed;
		}
		throw error;
	} finally {
		clearInterval(heartbeat);
		await heartbeatTask.catch(() => undefined);
		await cleanupJoinedTriggerEvents(request.period, state.runId).catch(
			() => undefined,
		);
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
	const lockPath = periodDigestRunLockPath(request.period);
	const lockStaleMs = dependencies.lockStaleMs ?? PERIOD_DIGEST_LOCK_STALE_MS;
	const acquisitionTimeoutMs =
		dependencies.lockAcquisitionTimeoutMs ??
		DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS;
	const acquisitionDeadline = Date.now() + acquisitionTimeoutMs;
	let releaseLock: ScheduledJobLockRelease | undefined;
	for (;;) {
		releaseLock = await acquireScheduledJobLock(
			lockPath,
			lockStaleMs,
			{ totalSources: DEFAULT_SOURCE_ORDER.length },
			MAX_RUN_AGE_MS,
		);
		if (releaseLock) break;
		const active = await waitForJoinableRunState({
			statePath,
			lockPath,
			lockStaleMs,
			timeoutMs:
				dependencies.stateReadyTimeoutMs ?? DEFAULT_STATE_READY_TIMEOUT_MS,
			pollIntervalMs:
				dependencies.completionPollIntervalMs ??
				DEFAULT_COMPLETION_POLL_INTERVAL_MS,
		});
		if (!active) {
			if (Date.now() >= acquisitionDeadline) {
				throw new Error(
					`Could not acquire the ${request.period} digest run lock within ${String(acquisitionTimeoutMs)}ms`,
				);
			}
			await (dependencies.sleep ?? defaultSleep)(
				dependencies.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
			);
			continue;
		}
		await recordJoinedTrigger(
			request.period,
			active.runId,
			{ trigger: request.trigger, origin: request.origin },
			dependencies.now(),
		).catch(() => undefined);
		return {
			runId: active.runId,
			joined: true,
			completion: waitForRunCompletion(
				statePath,
				lockPath,
				active.runId,
				lockStaleMs,
				dependencies.completionWaitTimeoutMs ?? MAX_RUN_AGE_MS,
				dependencies.completionPollIntervalMs ??
					DEFAULT_COMPLETION_POLL_INTERVAL_MS,
			),
		};
	}

	const state = createInitialState(
		request,
		releaseLock.ownerId,
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
