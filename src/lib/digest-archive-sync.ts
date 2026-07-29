import { Effect } from "effect";
import { getBirdclawConfig } from "./config";
import { syncMentionThreadsEffect } from "./mention-threads-live";
import { syncMentionsEffect } from "./mentions-live";
import {
	collectPeriodDigestContext,
	resolvePeriodDigestWindow,
	type PeriodDigestContentSource,
	type PeriodDigestPreset,
} from "./period-digest";
import { syncHomeTimelineEffect } from "./timeline-live";

export type DigestArchiveSyncStatus = "fresh" | "degraded" | "skipped";
export type DigestArchiveSyncOperation =
	| "following"
	| "for_you"
	| "mentions"
	| "mention_threads";
export type DigestArchiveSyncTransport = "bird" | "xurl" | "auto" | "local";

export interface DigestArchiveSyncStep {
	operation: DigestArchiveSyncOperation;
	status: DigestArchiveSyncStatus;
	transport: DigestArchiveSyncTransport;
	count?: number;
	error?: string;
}

export interface DigestArchiveSyncResult {
	status: DigestArchiveSyncStatus;
	steps: DigestArchiveSyncStep[];
}

export interface DigestArchivePreSyncOptions {
	period: PeriodDigestPreset;
	contentSources: PeriodDigestContentSource[];
	account?: string;
	since?: string;
	until?: string;
	liveSync: boolean;
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function configuredTransport(): DigestArchiveSyncTransport {
	const source = getBirdclawConfig().mentions?.dataSource;
	return source === "bird" || source === "xurl" || source === "auto"
		? source
		: "local";
}

function floorIsoToHour(value: string) {
	const date = new Date(value);
	date.setUTCMinutes(0, 0, 0);
	return date.toISOString();
}

function recordStep<A>({
	operation,
	transport,
	effect,
	count,
}: {
	operation: DigestArchiveSyncOperation;
	transport: DigestArchiveSyncTransport;
	effect: Effect.Effect<A, unknown>;
	count: (value: A) => number;
}): Effect.Effect<DigestArchiveSyncStep, never> {
	return effect.pipe(
		Effect.map(
			(value) =>
				({
					operation,
					status: "fresh",
					transport,
					count: count(value),
				}) satisfies DigestArchiveSyncStep,
		),
		Effect.catchAll((error) =>
			Effect.succeed({
				operation,
				status: "degraded",
				transport,
				error: messageFromError(error),
			} satisfies DigestArchiveSyncStep),
		),
	);
}

function skippedStep(
	operation: DigestArchiveSyncOperation,
): DigestArchiveSyncStep {
	return { operation, status: "skipped", transport: "local" };
}

function aggregateStatus(
	steps: DigestArchiveSyncStep[],
): DigestArchiveSyncStatus {
	if (steps.some((step) => step.status === "degraded")) return "degraded";
	if (steps.every((step) => step.status === "skipped")) {
		return "skipped";
	}
	return "fresh";
}

export function runDigestArchivePreSyncEffect(
	options: DigestArchivePreSyncOptions,
): Effect.Effect<DigestArchiveSyncResult, never> {
	if (!options.liveSync) {
		return Effect.succeed({ status: "skipped", steps: [] });
	}

	return Effect.gen(function* () {
		const steps: DigestArchiveSyncStep[] = [];
		const requested = new Set(options.contentSources);
		const needsFollowing = requested.has("all") || requested.has("following");
		const needsForYou = requested.has("all") || requested.has("for_you");
		const needsMentions = requested.has("all");
		const transport = configuredTransport();
		const window = resolvePeriodDigestWindow({
			period: options.period,
			since: options.since,
			until: options.until,
		});
		const startTime = floorIsoToHour(window.since);

		if (needsFollowing) {
			if (transport === "local") {
				steps.push(skippedStep("following"));
			} else {
				steps.push(
					yield* recordStep({
						operation: "following",
						transport,
						effect: syncHomeTimelineEffect({
							account: options.account,
							mode: transport,
							maxPages: 3,
							startTime,
							following: true,
							refresh: true,
							cacheTtlMs: 2 * 60_000,
							timeoutMs: 30_000,
						}),
						count: (value) => value.count,
					}),
				);
			}
		}

		if (needsForYou) {
			steps.push(
				yield* recordStep({
					operation: "for_you",
					transport: "bird",
					effect: syncHomeTimelineEffect({
						account: options.account,
						mode: "bird",
						maxPages: 3,
						startTime,
						following: false,
						refresh: true,
						cacheTtlMs: 2 * 60_000,
						timeoutMs: 30_000,
					}),
					count: (value) => value.count,
				}),
			);
		}

		if (needsMentions) {
			if (transport === "local") {
				steps.push(skippedStep("mentions"));
			} else {
				steps.push(
					yield* recordStep({
						operation: "mentions",
						transport,
						effect: syncMentionsEffect({
							account: options.account,
							mode: transport,
							limit: 100,
							maxPages: 3,
							...(transport === "bird" ? {} : { startTime }),
							refresh: true,
							cacheTtlMs: 2 * 60_000,
						}),
						count: (value) => value.count,
					}),
				);
			}

			if (transport === "local") {
				steps.push(skippedStep("mention_threads"));
			} else {
				const mentionIds = yield* Effect.try({
					try: () =>
						collectPeriodDigestContext({
							period: options.period,
							since: options.since,
							until: options.until,
							account: options.account,
							contentSource: "all",
						})
							.tweets.filter((tweet) => tweet.source === "mentions")
							.map((tweet) => tweet.id),
					catch: (error) => error,
				}).pipe(
					Effect.catchAll((error) => {
						steps.push({
							operation: "mention_threads",
							status: "degraded",
							transport: transport === "auto" ? "xurl" : transport,
							error: messageFromError(error),
						});
						return Effect.succeed(undefined);
					}),
				);
				if (mentionIds) {
					const threadTransport = transport === "auto" ? "xurl" : transport;
					const threadStep = yield* syncMentionThreadsEffect({
						account: options.account,
						mode: threadTransport,
						limit: 30,
						tweetIds: mentionIds,
						delayMs: 100,
						timeoutMs: 15_000,
						maxPages: 2,
					}).pipe(
						Effect.map((value) => {
							const problems = [
								value.failed > 0
									? `${String(value.failed)} mention thread fetch failed`
									: undefined,
								value.partial ? "thread context is partial" : undefined,
							].filter((problem): problem is string => Boolean(problem));
							return {
								operation: "mention_threads",
								status: problems.length > 0 ? "degraded" : "fresh",
								transport: threadTransport,
								count: value.uniqueTweets,
								...(problems.length > 0 ? { error: problems.join("; ") } : {}),
							} satisfies DigestArchiveSyncStep;
						}),
						Effect.catchAll((error) =>
							Effect.succeed({
								operation: "mention_threads",
								status: "degraded",
								transport: threadTransport,
								error: messageFromError(error),
							} satisfies DigestArchiveSyncStep),
						),
					);
					steps.push(threadStep);
				}
			}
		}

		return { status: aggregateStatus(steps), steps };
	});
}
