import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import {
	createAnalysisRequestBody,
	extractOpenAIResponseText,
	parseHybridAnalysis,
	requestHybridAnalysisEffect,
	resolveAnalysisModelSettings,
} from "./analysis-runtime";
import { getNativeDb } from "./db";
import { getBirdclawConfig } from "./config";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import {
	type LiveReadMode,
	resolveLiveReadMode,
	xurlDisabledTransportStatus,
} from "./live-transport-policy";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import type { Database } from "./sqlite";
import {
	editHistoryIdsFromPayload,
	reconcileTweetTombstones,
	recordTweetRevision,
} from "./tweet-retention";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import {
	type EffectivePrompt,
	materializeEffectivePrompt,
	PROMPT_TEMPLATE_DEFINITIONS,
	resolveEffectivePrompt,
} from "./prompt-templates";
import type { PlaygroundResultBase } from "./prompt-playground";
import { profileFromDbRow } from "./profile-row";
import { tweetEntitiesFromXurl } from "./tweet-render";
import type {
	ProfileRecord,
	TweetEntities,
	XurlMediaItem,
	XurlMentionUser,
	XurlTweetData,
	XurlTweetsResponse,
	XurlUserTweet,
	XurlUserTweetsResponse,
} from "./types";
import {
	type TweetAccountEdgeKind,
	upsertTweetAccountEdge,
} from "./tweet-account-edges";
import {
	buildExternalProfileId,
	getExternalUserId,
	upsertProfileFromXUser,
} from "./x-profile";
import { recordXurlRateLimitEventSafe } from "./xurl-rate-limits";
import type { XurlJsonCommandAttempt } from "./xurl";
import {
	getTransportStatusEffect,
	listUserTweetsEffect,
	lookupUsersByHandlesEffect,
	searchRecentByConversationIdEffect,
} from "./xurl";
import {
	listUserTweetsViaBirdEffect,
	listThreadViaBirdEffect,
	lookupProfileViaBirdEffect,
} from "./bird";

export interface ProfileAnalysisOptions {
	handle: string;
	account?: string;
	mode?: LiveReadMode;
	refresh?: boolean;
	maxTweets?: number;
	maxPages?: number;
	maxConversations?: number;
	maxConversationPages?: number;
	conversationDelayMs?: number;
	rateLimitRetryMs?: number;
	rateLimitMaxRetries?: number;
	cacheTtlMs?: number;
	model?: string;
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
	serviceTier?: "default" | "flex" | "priority";
	signal?: AbortSignal;
	language?: string;
}

export interface ProfileAnalysisStreamHandlers {
	onDelta?: (delta: string) => void;
	onEvent?: (event: ProfileAnalysisStreamEvent) => void;
}

export interface CompactProfileTweet {
	id: string;
	url: string;
	author: string;
	createdAt: string;
	text: string;
	entities?: TweetEntities;
	conversationId?: string;
	replyToId?: string;
	likeCount: number;
	replyCount: number;
	retweetCount: number;
	quoteCount: number;
	bookmarkedCount: number;
}

export interface CompactConversationTweet extends CompactProfileTweet {
	conversationRootId: string;
	profileId: string;
	name: string;
	bio: string;
	followersCount: number;
	avatarUrl?: string;
}

export interface ProfileAnalysisContext {
	handle: string;
	accountId: string;
	accountHandle: string;
	profile: ProfileRecord;
	profiles?: ProfileRecord[];
	externalUserId: string;
	tweets: CompactProfileTweet[];
	conversations: CompactConversationTweet[];
	counts: {
		tweets: number;
		tweetPages: number;
		conversationsScanned: number;
		conversationTweets: number;
		conversationPages: number;
	};
	fetchCached: boolean;
	hash: string;
}

const ProfileAnalysisSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	voice: z.string().min(1),
	themes: z.array(
		z.object({
			title: z.string().min(1),
			summary: z.string().min(1),
			tweetIds: z.array(z.string()).default([]),
			handles: z.array(z.string()).default([]),
		}),
	),
	conversationStyle: z.string().min(1),
	notableSignals: z.array(z.string()).default([]),
	risks: z.array(z.string()).default([]),
	followUps: z.array(z.string()).default([]),
	sourceTweetIds: z.array(z.string()).default([]),
	sourceHandles: z.array(z.string()).default([]),
});

export type ProfileAnalysis = z.infer<typeof ProfileAnalysisSchema>;

export interface ProfileAnalysisRunResult {
	context: ProfileAnalysisContext;
	analysis: ProfileAnalysis;
	markdown: string;
	model: string;
	reasoningEffort: string;
	serviceTier: string;
	parseStatus: "structured" | "fallback";
	cached: boolean;
	updatedAt: string;
}

export type ProfileAnalysisStreamEvent =
	| { type: "status"; label: string; detail?: string }
	| { type: "start"; context: ProfileAnalysisContext; cached: boolean }
	| { type: "delta"; delta: string }
	| { type: "done"; result: ProfileAnalysisRunResult }
	| { type: "error"; error: string };

export interface ProfileAnalysisPlaygroundOptions {
	handle: string;
	account?: string;
	language?: string;
	system: string;
	requirements: string;
	signal?: AbortSignal;
}

export interface ProfileAnalysisPlaygroundResult extends PlaygroundResultBase {
	analysis: ProfileAnalysis;
}

const DEFAULT_MAX_TWEETS = 10_000;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_CONVERSATIONS = 80;
const DEFAULT_MAX_CONVERSATION_PAGES = 3;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_CONVERSATION_DELAY_MS = 3_100;
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 1;
const XURL_PAGE_SIZE = 100;
const MAX_PROMPT_DATA_CHARS = 1_200_000;
const DELIMITER_PATTERN = /\n---\s*\n/;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function isXurlRateLimitError(error: Error) {
	// Structured classification from the transport (tag check, so it also works
	// across module instances); message heuristics stay as a fallback for 429s
	// that surface without a parseable payload.
	const tagged = error as { _tag?: unknown; rateLimited?: unknown };
	if (tagged._tag === "XurlCommandError" && tagged.rateLimited === true) {
		return true;
	}
	return (
		error.message.includes("Too Many Requests") ||
		error.message.includes('"status":429') ||
		/\b429\b/.test(error.message)
	);
}

function tryProfileSync<T>(try_: () => T): Effect.Effect<T, Error> {
	return Effect.try({ try: try_, catch: toError });
}

function tryProfilePromise<T>(
	try_: () => PromiseLike<T>,
): Effect.Effect<T, Error> {
	return tryPromise(try_).pipe(Effect.mapError(toError));
}

function normalizeHandle(value: string) {
	const handle = value
		.trim()
		.replace(/^https?:\/\/(x|twitter)\.com\//i, "")
		.replace(/^@/, "")
		.split(/[/?#]/)[0]
		?.trim();
	if (!handle) {
		throw new Error("Profile handle is required");
	}
	return handle;
}

function normalizePositiveInteger(
	value: number | undefined,
	defaultValue: number,
	optionName: string,
) {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value < 1) {
		throw new Error(`${optionName} must be at least 1`);
	}
	return Math.floor(value);
}

function normalizeCacheTtlMs(value: number | undefined) {
	if (value === undefined) return DEFAULT_CACHE_TTL_MS;
	if (!Number.isFinite(value) || value < 0) {
		return DEFAULT_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function normalizeNonNegativeInteger(
	value: number | undefined,
	defaultValue: number,
) {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value < 0) return defaultValue;
	return Math.floor(value);
}

function envNonNegativeInteger(name: string) {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return undefined;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) return undefined;
	return Math.floor(numeric);
}

function conversationDelayMsFromOptions(options: ProfileAnalysisOptions) {
	return normalizeNonNegativeInteger(
		options.conversationDelayMs ??
			envNonNegativeInteger("BIRDCLAW_PROFILE_ANALYSIS_CONVERSATION_DELAY_MS"),
		DEFAULT_CONVERSATION_DELAY_MS,
	);
}

function rateLimitRetryMsFromOptions(options: ProfileAnalysisOptions) {
	return normalizeNonNegativeInteger(
		options.rateLimitRetryMs ??
			envNonNegativeInteger("BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_RETRY_MS"),
		DEFAULT_RATE_LIMIT_RETRY_MS,
	);
}

function rateLimitMaxRetriesFromOptions(options: ProfileAnalysisOptions) {
	return normalizeNonNegativeInteger(
		options.rateLimitMaxRetries ??
			envNonNegativeInteger("BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_MAX_RETRIES"),
		DEFAULT_RATE_LIMIT_MAX_RETRIES,
	);
}

function normalizeAccountSelector(value: string | undefined) {
	const selector = value?.trim();
	if (!selector) return undefined;
	return selector;
}

function resolveAccount(db: Database, accountId?: string) {
	const selector = normalizeAccountSelector(
		accountId ?? process.env.BIRDCLAW_PROFILE_ANALYSIS_ACCOUNT,
	);
	const row = selector
		? (db
				.prepare(
					`
          select id, handle
          from accounts
          where id = ? or lower(trim(handle, '@')) = lower(trim(?, '@'))
          limit 1
          `,
				)
				.get(selector, selector) as { id: string; handle: string } | undefined)
		: (db
				.prepare(
					`
          select id, handle
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { id: string; handle: string } | undefined);
	if (!row) {
		throw new Error(`Unknown account: ${selector ?? "default"}`);
	}
	return row;
}

function modelFromOptions(options: ProfileAnalysisOptions) {
	return resolveAnalysisModelSettings(options).model;
}

function reasoningEffortFromOptions(options: ProfileAnalysisOptions) {
	return resolveAnalysisModelSettings(options).reasoningEffort;
}

function serviceTierFromOptions(options: ProfileAnalysisOptions) {
	return resolveAnalysisModelSettings(options).serviceTier;
}

function tweetUrl(handle: string, id: string) {
	return `https://x.com/${handle}/status/${id}`;
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	const row = db
		.prepare("select deleted_at, superseded_at from tweets where id = ?")
		.get(tweetId) as
		| { deleted_at: string | null; superseded_at: string | null }
		| undefined;
	if (row?.deleted_at || row?.superseded_at) return;
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function refreshTweetFts(
	db: Database,
	tweetId: string,
	text: string,
	previousText: string | null,
) {
	if (previousText === text) return;
	if (previousText !== null) {
		replaceTweetFts(db, tweetId, text);
		return;
	}
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function mergeXurlTweetsIntoLocalStore(
	db: Database,
	accountId: string,
	payload: XurlTweetsResponse,
	edgeKind: TweetAccountEdgeKind,
	source: "xurl" | "cache",
) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const upsertTweet = db.prepare(
		`
    insert into tweets (
      id, author_profile_id, text, created_at, is_replied, reply_to_id,
      like_count, media_count, entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      author_profile_id = excluded.author_profile_id,
      text = excluded.text,
      created_at = excluded.created_at,
      reply_to_id = coalesce(tweets.reply_to_id, excluded.reply_to_id),
      like_count = excluded.like_count,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = excluded.entities_json,
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      quoted_tweet_id = coalesce(tweets.quoted_tweet_id, excluded.quoted_tweet_id)
    `,
	);
	const existingTweet = db.prepare("select text from tweets where id = ?");
	const seenAt = new Date().toISOString();
	const touchedTweetIds: string[] = [];
	db.transaction(() => {
		for (const tweet of payload.data) {
			const authorId = tweet.author_id;
			if (!authorId) continue;
			const author = usersById.get(authorId);
			if (!author) continue;
			touchedTweetIds.push(tweet.id);
			const profile = upsertProfileFromXUser(db, author);
			const replyToId =
				tweet.referenced_tweets?.find((item) => item.type === "replied_to")
					?.id ?? null;
			const quotedTweetId =
				tweet.referenced_tweets?.find((item) => item.type === "quoted")?.id ??
				null;
			const previousTweet = existingTweet.get(tweet.id) as
				| { text: string | null }
				| undefined;
			const previousText =
				previousTweet && typeof previousTweet.text === "string"
					? previousTweet.text
					: null;
			upsertTweet.run(
				tweet.id,
				profile.profile.id,
				tweet.text,
				tweet.created_at,
				replyToId,
				Number(tweet.public_metrics?.like_count ?? 0),
				countTweetMedia(tweet),
				JSON.stringify(tweetEntitiesFromXurl(tweet.entities)),
				buildMediaJsonFromIncludes(tweet, payload.includes?.media),
				quotedTweetId,
			);
			recordTweetRevision(db, {
				tweetId: tweet.id,
				editHistoryIds: editHistoryIdsFromPayload(tweet.id, tweet),
				payloadJson: JSON.stringify(tweet),
				source,
				observedAt: seenAt,
			});
			upsertTweetAccountEdge(db, {
				accountId,
				tweetId: tweet.id,
				kind: edgeKind,
				source,
				seenAt,
				rawJson: JSON.stringify(tweet),
			});
			refreshTweetFts(db, tweet.id, tweet.text, previousText);
		}
		reconcileTweetTombstones(db, touchedTweetIds);
	})();
}

function toTweetData(
	tweet: XurlUserTweet,
	fallbackAuthorId: string,
): XurlTweetData {
	return {
		...tweet,
		author_id: tweet.author_id ?? fallbackAuthorId,
	};
}

function userTimelineToTweetsResponse(
	response: XurlUserTweetsResponse,
	fallbackAuthorId: string,
): XurlTweetsResponse {
	return {
		data: response.items.map((tweet) => toTweetData(tweet, fallbackAuthorId)),
		includes: response.includes,
		meta: {
			result_count: response.items.length,
			...(response.nextToken ? { next_token: response.nextToken } : {}),
		},
	};
}

function mergeResponses(responses: XurlTweetsResponse[]): XurlTweetsResponse {
	const seenTweetIds = new Set<string>();
	const usersById = new Map<string, XurlMentionUser>();
	const mediaByKey = new Map<string, XurlMediaItem>();
	const data: XurlTweetData[] = [];
	for (const response of responses) {
		for (const user of response.includes?.users ?? []) {
			usersById.set(user.id, user);
		}
		for (const media of response.includes?.media ?? []) {
			mediaByKey.set(media.media_key, media);
		}
		for (const tweet of response.data) {
			if (seenTweetIds.has(tweet.id)) continue;
			seenTweetIds.add(tweet.id);
			data.push(tweet);
		}
	}
	return {
		data,
		includes: {
			users: [...usersById.values()],
			media: [...mediaByKey.values()],
		},
		meta: { result_count: data.length },
	};
}

function compactProfileTweet(
	tweet: XurlTweetData,
	profileHandle: string,
): CompactProfileTweet {
	return {
		id: tweet.id,
		url: tweetUrl(profileHandle, tweet.id),
		author: profileHandle,
		createdAt: tweet.created_at,
		text: tweet.text,
		entities: tweetEntitiesFromXurl(tweet.entities),
		...(tweet.conversation_id ? { conversationId: tweet.conversation_id } : {}),
		...(tweet.referenced_tweets?.find((item) => item.type === "replied_to")?.id
			? {
					replyToId: tweet.referenced_tweets.find(
						(item) => item.type === "replied_to",
					)?.id,
				}
			: {}),
		likeCount: Number(tweet.public_metrics?.like_count ?? 0),
		replyCount: Number(tweet.public_metrics?.reply_count ?? 0),
		retweetCount: Number(tweet.public_metrics?.retweet_count ?? 0),
		quoteCount: Number(tweet.public_metrics?.quote_count ?? 0),
		bookmarkedCount: Number(tweet.public_metrics?.bookmark_count ?? 0),
	};
}

function compactConversationTweet(
	tweet: XurlTweetData,
	usersById: Map<string, XurlMentionUser>,
	conversationRootId: string,
): CompactConversationTweet | null {
	const user = usersById.get(tweet.author_id);
	if (!user) return null;
	return {
		...compactProfileTweet(tweet, user.username),
		conversationRootId,
		profileId: buildExternalProfileId(user.id),
		name: user.name,
		bio: user.description ?? "",
		followersCount: Number(user.public_metrics?.followers_count ?? 0),
		...(user.profile_image_url ? { avatarUrl: user.profile_image_url } : {}),
	};
}

function contextCacheKey(options: {
	accountId: string;
	handle: string;
	mode: LiveReadMode;
	maxTweets: number;
	maxPages: number;
	maxConversations: number;
	maxConversationPages: number;
}) {
	return [
		"profile-analysis:context",
		options.accountId,
		options.handle.toLowerCase(),
		options.mode,
		String(options.maxTweets),
		String(options.maxPages),
		String(options.maxConversations),
		String(options.maxConversationPages),
	].join(":");
}

function promptTweetContext(tweet: CompactProfileTweet) {
	const { entities: _entities, ...promptTweet } = tweet;
	return promptTweet;
}

function contextHash(context: Omit<ProfileAnalysisContext, "hash">) {
	return createHash("sha1")
		.update(
			JSON.stringify({
				handle: context.handle,
				accountId: context.accountId,
				accountHandle: context.accountHandle,
				externalUserId: context.externalUserId,
				profile: context.profile,
				counts: context.counts,
				tweets: context.tweets.map(promptTweetContext),
				conversations: context.conversations.map(promptTweetContext),
			}),
		)
		.digest("hex");
}

function parseLocalJson(value: unknown): Record<string, unknown> {
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function localTweetPayload(row: Record<string, unknown>) {
	return parseLocalJson(row.payload_json);
}

function localTweetMetrics(payload: Record<string, unknown>) {
	const metrics = payload.public_metrics;
	return metrics && typeof metrics === "object" && !Array.isArray(metrics)
		? (metrics as Record<string, unknown>)
		: {};
}

function compactLocalProfileTweet(
	row: Record<string, unknown>,
	handle: string,
): CompactProfileTweet {
	const payload = localTweetPayload(row);
	const metrics = localTweetMetrics(payload);
	const entities = Object.keys(payload).length
		? tweetEntitiesFromXurl(payload.entities)
		: (parseLocalJson(row.entities_json) as TweetEntities);
	const conversationId =
		typeof payload.conversation_id === "string"
			? payload.conversation_id
			: undefined;
	const replyToId =
		typeof row.reply_to_id === "string" ? row.reply_to_id : undefined;
	return {
		id: String(row.id),
		url: tweetUrl(handle, String(row.id)),
		author: handle,
		createdAt: String(row.created_at),
		text: String(row.text),
		entities,
		...(conversationId ? { conversationId } : {}),
		...(replyToId ? { replyToId } : {}),
		likeCount: Number(metrics.like_count ?? row.like_count ?? 0),
		replyCount: Number(metrics.reply_count ?? 0),
		retweetCount: Number(metrics.retweet_count ?? 0),
		quoteCount: Number(metrics.quote_count ?? 0),
		bookmarkedCount: Number(metrics.bookmark_count ?? 0),
	};
}

function localProfileRowColumns(prefix = "profile_") {
	return [
		"id",
		"handle",
		"display_name",
		"bio",
		"followers_count",
		"following_count",
		"avatar_hue",
		"avatar_url",
		"location",
		"url",
		"verified_type",
		"entities_json",
		"created_at",
	]
		.map((column) => `p.${column} as ${prefix}${column}`)
		.join(", ");
}

export function collectProfileAnalysisContextLocalOnly(
	options: Pick<
		ProfileAnalysisOptions,
		"handle" | "account" | "maxTweets" | "maxConversations" | "signal"
	>,
): ProfileAnalysisContext {
	if (options.signal?.aborted) throw new Error("Profile analysis aborted");
	const db = getNativeDb();
	const handle = normalizeHandle(options.handle);
	const account = resolveAccount(db, options.account);
	const maxTweets = normalizePositiveInteger(
		options.maxTweets,
		DEFAULT_MAX_TWEETS,
		"maxTweets",
	);
	const maxConversations = normalizePositiveInteger(
		options.maxConversations,
		DEFAULT_MAX_CONVERSATIONS,
		"maxConversations",
	);
	const profileRow = db
		.prepare("select * from profiles where lower(handle) = lower(?) limit 1")
		.get(handle) as Record<string, unknown> | undefined;
	if (!profileRow) {
		throw new Error(`No local profile data found for @${handle}`);
	}
	const profile = profileFromDbRow(profileRow);
	const tweetRows = db
		.prepare(
			`
        select t.*,
          (select tr.payload_json
           from tweet_revisions tr
           where tr.root_tweet_id = t.id
           order by tr.revision_index desc
           limit 1) as payload_json
        from tweets t
        where t.author_profile_id = ?
          and t.deleted_at is null
          and t.superseded_at is null
        order by t.created_at desc, t.id desc
        limit ?
        `,
		)
		.all(profile.id, maxTweets) as Array<Record<string, unknown>>;
	const tweets = tweetRows.map((row) =>
		compactLocalProfileTweet(row, profile.handle),
	);
	const conversationRoots = [
		...new Set(tweets.map((tweet) => tweet.conversationId ?? tweet.id)),
	].slice(0, maxConversations);
	const conversations: CompactConversationTweet[] = [];
	const profiles = new Map<string, ProfileRecord>([[profile.id, profile]]);
	if (conversationRoots.length > 0) {
		const placeholders = conversationRoots.map(() => "?").join(",");
		const rows = db
			.prepare(
				`
          with local_tweets as (
            select t.*,
              (select tr.payload_json
               from tweet_revisions tr
               where tr.root_tweet_id = t.id
               order by tr.revision_index desc
               limit 1) as payload_json
            from tweets t
            where t.deleted_at is null and t.superseded_at is null
          )
          select local_tweets.*, ${localProfileRowColumns()}
          from local_tweets
          join profiles p on p.id = local_tweets.author_profile_id
          where local_tweets.id in (${placeholders})
             or local_tweets.reply_to_id in (${placeholders})
             or json_extract(local_tweets.payload_json, '$.conversation_id') in (${placeholders})
          order by local_tweets.created_at desc, local_tweets.id desc
          limit ?
          `,
			)
			.all(
				...conversationRoots,
				...conversationRoots,
				...conversationRoots,
				maxTweets * 3,
			) as Array<Record<string, unknown>>;
		const rootSet = new Set(conversationRoots);
		for (const row of rows) {
			const author = profileFromDbRow(row, "profile_");
			profiles.set(author.id, author);
			const payload = localTweetPayload(row);
			const payloadConversationId =
				typeof payload.conversation_id === "string"
					? payload.conversation_id
					: undefined;
			const rowId = String(row.id);
			const replyToId =
				typeof row.reply_to_id === "string" ? row.reply_to_id : undefined;
			const conversationRootId = payloadConversationId
				? payloadConversationId
				: rootSet.has(rowId)
					? rowId
					: replyToId && rootSet.has(replyToId)
						? replyToId
						: undefined;
			if (!conversationRootId || !rootSet.has(conversationRootId)) continue;
			conversations.push({
				...compactLocalProfileTweet(row, author.handle),
				conversationRootId,
				profileId: author.id,
				name: author.displayName,
				bio: author.bio,
				followersCount: author.followersCount,
				...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
			});
		}
	}
	const withoutHash = {
		handle: profile.handle,
		accountId: account.id,
		accountHandle: account.handle,
		profile,
		profiles: [...profiles.values()],
		externalUserId: getExternalUserId(profile.id) ?? profile.id,
		tweets,
		conversations,
		counts: {
			tweets: tweets.length,
			tweetPages: tweets.length > 0 ? 1 : 0,
			conversationsScanned: conversationRoots.length,
			conversationTweets: conversations.length,
			conversationPages: conversations.length > 0 ? 1 : 0,
		},
		fetchCached: false,
	} satisfies Omit<ProfileAnalysisContext, "hash">;
	return { ...withoutHash, hash: contextHash(withoutHash) };
}

function resultCacheKey(
	context: ProfileAnalysisContext,
	options: ProfileAnalysisOptions,
	promptHash: string,
) {
	return [
		"profile-analysis:result",
		promptHash,
		modelFromOptions(options),
		reasoningEffortFromOptions(options),
		serviceTierFromOptions(options),
		options.language || getBirdclawConfig().language?.aiLanguage || "zh-CN",
		context.hash,
	].join(":");
}

function topConversationIds(tweets: XurlTweetData[], maxConversations: number) {
	const candidates = new Map<
		string,
		{ id: string; score: number; createdAt: string }
	>();
	for (const tweet of tweets) {
		const id = tweet.conversation_id;
		if (!id) continue;
		const score =
			Number(tweet.public_metrics?.reply_count ?? 0) * 8 +
			Number(tweet.public_metrics?.quote_count ?? 0) * 4 +
			Number(tweet.public_metrics?.like_count ?? 0);
		const existing = candidates.get(id);
		if (!existing || score > existing.score) {
			candidates.set(id, { id, score, createdAt: tweet.created_at });
		}
	}
	return [...candidates.values()]
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.createdAt.localeCompare(left.createdAt),
		)
		.slice(0, maxConversations)
		.map((item) => item.id);
}

function buildContextFromPayloads({
	account,
	handle,
	profile,
	externalUserId,
	tweetResponses,
	conversationResponses,
	conversationRoots,
	tweetPages,
	conversationPages,
	fetchCached,
}: {
	account: { id: string; handle: string };
	handle: string;
	profile: ProfileRecord;
	externalUserId: string;
	tweetResponses: XurlTweetsResponse[];
	conversationResponses: XurlTweetsResponse[];
	conversationRoots: string[];
	tweetPages: number;
	conversationPages: number;
	fetchCached: boolean;
}): ProfileAnalysisContext {
	const tweetPayload = mergeResponses(tweetResponses);
	const conversationPayload = mergeResponses(conversationResponses);
	const profileTweets = tweetPayload.data
		.map((tweet) => compactProfileTweet(tweet, handle))
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const usersById = new Map(
		(conversationPayload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const conversationSet = new Set(conversationRoots);
	const conversations = conversationPayload.data
		.filter(
			(tweet) =>
				tweet.conversation_id && conversationSet.has(tweet.conversation_id),
		)
		.map((tweet) =>
			compactConversationTweet(tweet, usersById, tweet.conversation_id ?? ""),
		)
		.filter((tweet): tweet is CompactConversationTweet => tweet !== null)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const withoutHash = {
		handle,
		accountId: account.id,
		accountHandle: account.handle,
		profile,
		externalUserId,
		tweets: profileTweets,
		conversations,
		counts: {
			tweets: profileTweets.length,
			tweetPages,
			conversationsScanned: conversationRoots.length,
			conversationTweets: conversations.length,
			conversationPages,
		},
		fetchCached,
	} satisfies Omit<ProfileAnalysisContext, "hash">;
	return {
		...withoutHash,
		hash: contextHash(withoutHash),
	};
}

function emitStatus(
	handlers: ProfileAnalysisStreamHandlers,
	label: string,
	detail?: string,
) {
	handlers.onEvent?.({
		type: "status",
		label,
		...(detail ? { detail } : {}),
	});
}

function abortIfRequestedEffect(signal: AbortSignal | undefined) {
	return tryProfileSync(() => {
		if (signal?.aborted) {
			throw new Error("Profile analysis aborted");
		}
	});
}

function sleepWithAbortEffect(ms: number, signal: AbortSignal | undefined) {
	if (ms <= 0) return abortIfRequestedEffect(signal);
	return tryProfilePromise(
		() =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Profile analysis aborted"));
					return;
				}
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, ms);
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error("Profile analysis aborted"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
	);
}

export function collectProfileAnalysisContextEffect(
	options: ProfileAnalysisOptions,
	handlers: ProfileAnalysisStreamHandlers = {},
): Effect.Effect<ProfileAnalysisContext, Error> {
	return Effect.gen(function* () {
		const db = getNativeDb();
		const handle = yield* tryProfileSync(() => normalizeHandle(options.handle));
		const account = yield* tryProfileSync(() =>
			resolveAccount(db, options.account),
		);
		const maxTweets = yield* tryProfileSync(() =>
			normalizePositiveInteger(
				options.maxTweets,
				DEFAULT_MAX_TWEETS,
				"--max-tweets",
			),
		);
		const maxPages = yield* tryProfileSync(() =>
			normalizePositiveInteger(
				options.maxPages,
				DEFAULT_MAX_PAGES,
				"--max-pages",
			),
		);
		const maxConversations = yield* tryProfileSync(() =>
			normalizePositiveInteger(
				options.maxConversations,
				DEFAULT_MAX_CONVERSATIONS,
				"--max-conversations",
			),
		);
		const maxConversationPages = yield* tryProfileSync(() =>
			normalizePositiveInteger(
				options.maxConversationPages,
				DEFAULT_MAX_CONVERSATION_PAGES,
				"--max-conversation-pages",
			),
		);
		const conversationDelayMs = conversationDelayMsFromOptions(options);
		const rateLimitRetryMs = rateLimitRetryMsFromOptions(options);
		const rateLimitMaxRetries = rateLimitMaxRetriesFromOptions(options);
		const cacheTtlMs = normalizeCacheTtlMs(options.cacheTtlMs);
		const liveMode = resolveLiveReadMode(options.mode);
		const contextKey = contextCacheKey({
			accountId: account.id,
			handle,
			mode: liveMode,
			maxTweets,
			maxPages,
			maxConversations,
			maxConversationPages,
		});
		const cached = yield* tryProfileSync(() =>
			readSyncCache<ProfileAnalysisContext>(contextKey, db),
		);
		const ageMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;
		if (!options.refresh && cached && ageMs <= cacheTtlMs) {
			emitStatus(handlers, "Using cached profile backfill", `@${handle}`);
			return { ...cached.value, fetchCached: true };
		}

		const recordTimelineAttempt = (attempt: XurlJsonCommandAttempt) =>
			recordXurlRateLimitEventSafe({
				endpoint: "users_id_tweets",
				status: attempt.status,
				source: "profile-analysis:timeline",
				handle,
				...(attempt.error ? { detail: attempt.error.message } : {}),
			});
		const recordConversationAttempt = (attempt: XurlJsonCommandAttempt) =>
			recordXurlRateLimitEventSafe({
				endpoint: "tweets_search_recent",
				status: attempt.status,
				source: "profile-analysis:conversation",
				handle,
				...(attempt.error ? { detail: attempt.error.message } : {}),
			});

		emitStatus(handlers, "Resolving profile", `@${handle}`);
		yield* abortIfRequestedEffect(options.signal);

		let user: XurlMentionUser | undefined;
		const transport =
			liveMode === "bird"
				? xurlDisabledTransportStatus()
				: yield* getTransportStatusEffect();

		if (transport.availableTransport === "xurl") {
			const [xurlUser] = yield* lookupUsersByHandlesEffect([handle], {
				auth: "oauth2",
				signal: options.signal,
				useConfiguredCandidate: false,
			}).pipe(Effect.catchAll(() => Effect.succeed([undefined])));
			user = xurlUser;
		}

		if (!user) {
			const birdResult = yield* lookupProfileViaBirdEffect(handle).pipe(
				Effect.catchAll(() => Effect.succeed(null)),
			);
			user = birdResult ?? undefined;
		}

		yield* abortIfRequestedEffect(options.signal);
		if (!user) {
			return yield* Effect.fail(new Error(`Could not resolve @${handle}`));
		}
		const resolved = yield* tryProfileSync(() =>
			upsertProfileFromXUser(db, user),
		);

		let profilePayload: XurlTweetsResponse;
		let tweetResponses: XurlTweetsResponse[] = [];
		let tweetPages = 0;

		if (transport.availableTransport === "xurl") {
			let nextToken: string | undefined;
			let fetchedTweets = 0;
			for (
				let page = 0;
				page < maxPages && fetchedTweets < maxTweets;
				page += 1
			) {
				yield* abortIfRequestedEffect(options.signal);
				const remaining = maxTweets - fetchedTweets;
				emitStatus(
					handlers,
					"Fetching profile tweets",
					`page ${String(page + 1)} · ${String(fetchedTweets)} tweets`,
				);
				const response = yield* listUserTweetsEffect(resolved.externalUserId, {
					maxResults: Math.max(5, Math.min(XURL_PAGE_SIZE, remaining)),
					paginationToken: nextToken,
					excludeRetweets: false,
					auth: "oauth2",
					tweetFields: [
						"created_at",
						"conversation_id",
						"entities",
						"public_metrics",
						"referenced_tweets",
						"in_reply_to_user_id",
						"attachments",
					],
					expansions: ["author_id", "attachments.media_keys"],
					userFields: [
						"description",
						"entities",
						"location",
						"public_metrics",
						"profile_image_url",
						"url",
						"created_at",
						"verified",
						"verified_type",
					],
					signal: options.signal,
					onAttempt: recordTimelineAttempt,
					useConfiguredCandidate: false,
				});
				yield* abortIfRequestedEffect(options.signal);
				const limitedResponse =
					response.items.length > remaining
						? { ...response, items: response.items.slice(0, remaining) }
						: response;
				tweetPages += 1;
				fetchedTweets += limitedResponse.items.length;
				tweetResponses.push(
					userTimelineToTweetsResponse(
						limitedResponse,
						resolved.externalUserId,
					),
				);
				nextToken =
					fetchedTweets < maxTweets
						? (response.nextToken ?? undefined)
						: undefined;
				if (!nextToken || limitedResponse.items.length === 0) break;
			}
			profilePayload = mergeResponses(tweetResponses);
		} else {
			emitStatus(handlers, "Fetching profile tweets via bird", `@${handle}`);
			const birdResult = yield* listUserTweetsViaBirdEffect({
				handle,
				maxResults: maxTweets,
			}).pipe(
				Effect.catchAll((err) => {
					console.error("bird user-tweets failed:", err);
					return Effect.succeed({ data: [] } as XurlTweetsResponse);
				}),
			);
			profilePayload = {
				data: birdResult.data,
				includes: birdResult.includes,
				meta: {
					result_count: birdResult.data.length,
				},
			};
			tweetResponses = [profilePayload];
			tweetPages = 1;
		}
		yield* tryProfileSync(() =>
			mergeXurlTweetsIntoLocalStore(
				db,
				account.id,
				profilePayload,
				"profile",
				"xurl",
			),
		);

		const conversationRoots = topConversationIds(
			profilePayload.data,
			maxConversations,
		);
		const conversationResponses: XurlTweetsResponse[] = [];
		let conversationPages = 0;
		let conversationRateLimited = false;
		let conversationRequestCount = 0;

		if (transport.availableTransport === "xurl") {
			for (const [index, conversationId] of conversationRoots.entries()) {
				if (conversationRateLimited) break;
				let conversationNextToken: string | undefined;
				for (let page = 0; page < maxConversationPages; page += 1) {
					yield* abortIfRequestedEffect(options.signal);
					if (conversationRequestCount > 0 && conversationDelayMs > 0) {
						emitStatus(
							handlers,
							"Throttling conversation fetch",
							`${String(conversationDelayMs)}ms`,
						);
						yield* sleepWithAbortEffect(conversationDelayMs, options.signal);
					}
					emitStatus(
						handlers,
						"Fetching conversations",
						`${String(index + 1)}/${String(conversationRoots.length)} · page ${String(page + 1)}`,
					);
					let response: XurlTweetsResponse | null = null;
					for (let attempt = 0; attempt <= rateLimitMaxRetries; attempt += 1) {
						conversationRequestCount += 1;
						response = yield* searchRecentByConversationIdEffect(
							conversationId,
							{
								maxResults: XURL_PAGE_SIZE,
								paginationToken: conversationNextToken,
								timeoutMs: 30_000,
								auth: "oauth2",
								signal: options.signal,
								onAttempt: recordConversationAttempt,
							},
						).pipe(
							Effect.catchAll((error) => {
								if (!isXurlRateLimitError(error)) {
									return Effect.fail(error);
								}
								if (attempt < rateLimitMaxRetries) {
									emitStatus(
										handlers,
										"Conversation fetch rate limited",
										`retrying in ${String(rateLimitRetryMs)}ms`,
									);
									return sleepWithAbortEffect(
										rateLimitRetryMs,
										options.signal,
									).pipe(Effect.as(null));
								}
								conversationRateLimited = true;
								emitStatus(
									handlers,
									"Conversation fetch rate limited",
									"using partial profile context",
								);
								return Effect.succeed(null);
							}),
						);
						if (response || conversationRateLimited) {
							break;
						}
						if (conversationDelayMs > 0) {
							emitStatus(
								handlers,
								"Throttling conversation retry",
								`${String(conversationDelayMs)}ms`,
							);
							yield* sleepWithAbortEffect(conversationDelayMs, options.signal);
						}
					}
					if (!response) break;
					yield* abortIfRequestedEffect(options.signal);
					conversationPages += 1;
					conversationResponses.push(response);
					conversationNextToken =
						typeof response.meta?.next_token === "string"
							? String(response.meta.next_token)
							: undefined;
					if (!conversationNextToken || response.data.length === 0) break;
				}
			}
		} else {
			for (const [index, conversationId] of conversationRoots.entries()) {
				yield* abortIfRequestedEffect(options.signal);
				emitStatus(
					handlers,
					"Fetching conversation via bird",
					`${String(index + 1)}/${String(conversationRoots.length)} · ID ${conversationId}`,
				);
				const birdResult = yield* listThreadViaBirdEffect({
					tweetId: conversationId,
					timeoutMs: 30_000,
				}).pipe(
					Effect.catchAll((err) => {
						console.error("bird thread fetch failed:", err);
						return Effect.succeed(null);
					}),
				);
				if (birdResult) {
					conversationPages += 1;
					conversationResponses.push({
						data: birdResult.data,
						includes: birdResult.includes,
						meta: {
							result_count: birdResult.data.length,
						},
					});
				}
			}
		}
		const conversationPayload = mergeResponses(conversationResponses);
		yield* tryProfileSync(() =>
			mergeXurlTweetsIntoLocalStore(
				db,
				account.id,
				conversationPayload,
				"thread_context",
				"xurl",
			),
		);

		const context = buildContextFromPayloads({
			account,
			handle: resolved.profile.handle,
			profile: resolved.profile,
			externalUserId: resolved.externalUserId,
			tweetResponses,
			conversationResponses,
			conversationRoots,
			tweetPages,
			conversationPages,
			fetchCached: false,
		});
		if (!conversationRateLimited) {
			yield* tryProfileSync(() => writeSyncCache(contextKey, context, db));
		}
		return context;
	});
}

function fitPromptDataset(context: ProfileAnalysisContext) {
	let tweetCount = context.tweets.length;
	let conversationCount = context.conversations.length;
	const datasetFor = (tweets: number, conversations: number) => ({
		profile: context.profile,
		counts: context.counts,
		tweets: context.tweets.slice(0, tweets).map(promptTweetContext),
		conversations: context.conversations
			.slice(0, conversations)
			.map(promptTweetContext),
	});
	const lengthFor = (tweets: number, conversations: number) =>
		JSON.stringify(datasetFor(tweets, conversations)).length;
	const fitCount = (max: number, fits: (count: number) => boolean) => {
		let low = 0;
		let high = max;
		let best = 0;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (fits(mid)) {
				best = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		return best;
	};
	if (lengthFor(tweetCount, conversationCount) <= MAX_PROMPT_DATA_CHARS) {
		return {
			dataset: datasetFor(tweetCount, conversationCount),
			tweetCount,
			conversationCount,
		};
	}
	conversationCount = fitCount(
		conversationCount,
		(count) => lengthFor(tweetCount, count) <= MAX_PROMPT_DATA_CHARS,
	);
	if (lengthFor(tweetCount, conversationCount) > MAX_PROMPT_DATA_CHARS) {
		tweetCount = fitCount(
			tweetCount,
			(count) => lengthFor(count, conversationCount) <= MAX_PROMPT_DATA_CHARS,
		);
	}
	return {
		dataset: datasetFor(tweetCount, conversationCount),
		tweetCount,
		conversationCount,
	};
}

function buildPrompt(
	context: ProfileAnalysisContext,
	options: ProfileAnalysisOptions,
	effectivePrompt: EffectivePrompt,
) {
	const { dataset, tweetCount, conversationCount } = fitPromptDataset(context);
	const language =
		options.language || getBirdclawConfig().language?.aiLanguage || "zh-CN";
	const isChinese =
		language === "zh-CN" || language === "zh" || language.startsWith("zh");

	const langInstruction = isChinese
		? "\n- Output all analysis content (including markdown sections, the JSON 'title', 'summary', 'voice', theme 'title' and 'summary', 'conversationStyle', etc.) in Simplified Chinese (简体中文). Keep the JSON keys and structure exactly as specified in English."
		: "";

	return `Profile: @${context.handle}
Account cache: ${context.accountId} (${context.accountHandle})
Fetched profile tweets: ${String(context.counts.tweets)} across ${String(context.counts.tweetPages)} pages
Fetched conversation tweets: ${String(context.counts.conversationTweets)} across ${String(context.counts.conversationPages)} pages
Prompt tweets: ${String(tweetCount)} of ${String(context.tweets.length)}
Prompt conversation tweets: ${String(conversationCount)} of ${String(context.conversations.length)}

Write a high-signal Markdown profile analysis from X/Twitter API data.

Requirements:
${effectivePrompt.requirements}${langInstruction}

Dataset:
${JSON.stringify(dataset)}`;
}

function fallbackAnalysis(
	context: ProfileAnalysisContext,
	markdown: string,
): ProfileAnalysis {
	return {
		title: `Profile analysis: @${context.handle}`,
		summary:
			markdown.replaceAll(/\s+/g, " ").trim().slice(0, 320) ||
			"No model summary was returned.",
		voice: "Not enough structured output was returned to classify voice.",
		themes: [],
		conversationStyle: "Not enough structured output was returned.",
		notableSignals: [],
		risks: [],
		followUps: [],
		sourceTweetIds: context.tweets.slice(0, 20).map((tweet) => tweet.id),
		sourceHandles: [context.handle],
	};
}

function parseAnalysisFromHybridText(
	context: ProfileAnalysisContext,
	rawText: string,
): {
	analysis: ProfileAnalysis;
	markdown: string;
	parseStatus: "structured" | "fallback";
} {
	const parsed = parseHybridAnalysis({
		rawText,
		parse: (value) => ProfileAnalysisSchema.parse(value),
		fallback: (markdown) => fallbackAnalysis(context, markdown),
		delimiterPattern: DELIMITER_PATTERN,
	});
	return {
		markdown: parsed.markdown,
		analysis: parsed.value,
		parseStatus: parsed.parseStatus,
	};
}

function extractResponseText(payload: Record<string, unknown>) {
	return extractOpenAIResponseText(payload);
}

function createOpenAIRequestBody(
	context: ProfileAnalysisContext,
	options: ProfileAnalysisOptions,
	effectivePrompt: EffectivePrompt,
) {
	return createAnalysisRequestBody({
		settings: resolveAnalysisModelSettings(options),
		system: effectivePrompt.system,
		prompt: buildPrompt(context, options, effectivePrompt),
		stream: false,
	});
}

export function streamProfileAnalysisEffect(
	options: ProfileAnalysisOptions,
	handlers: ProfileAnalysisStreamHandlers = {},
): Effect.Effect<ProfileAnalysisRunResult, Error> {
	return Effect.gen(function* () {
		const effectivePrompt = yield* tryProfileSync(() =>
			resolveEffectivePrompt("profile-analysis"),
		);
		const context = yield* collectProfileAnalysisContextEffect(
			options,
			handlers,
		);
		const cached = options.refresh
			? null
			: yield* tryProfileSync(() =>
					readSyncCache<{
						analysis: ProfileAnalysis;
						markdown: string;
						model: string;
						reasoningEffort: string;
						serviceTier: string;
						parseStatus: "structured" | "fallback";
					}>(resultCacheKey(context, options, effectivePrompt.promptHash)),
				);
		if (cached) {
			const result: ProfileAnalysisRunResult = yield* tryProfileSync(() => ({
				context,
				analysis: ProfileAnalysisSchema.parse(cached.value.analysis),
				markdown: cached.value.markdown,
				model: cached.value.model,
				reasoningEffort: cached.value.reasoningEffort,
				serviceTier: cached.value.serviceTier,
				parseStatus: cached.value.parseStatus,
				cached: true,
				updatedAt: cached.updatedAt,
			}));
			handlers.onEvent?.({ type: "start", context, cached: true });
			handlers.onDelta?.(result.markdown);
			handlers.onEvent?.({ type: "delta", delta: result.markdown });
			handlers.onEvent?.({ type: "done", result });
			return result;
		}

		handlers.onEvent?.({ type: "start", context, cached: false });
		emitStatus(handlers, "Summarizing with AI", modelFromOptions(options));
		const analysisResponse = yield* requestHybridAnalysisEffect({
			body: createOpenAIRequestBody(context, options, effectivePrompt),
			signal: options.signal,
			parse: (value) => ProfileAnalysisSchema.parse(value),
			fallback: (markdown) => fallbackAnalysis(context, markdown),
			delimiterPattern: DELIMITER_PATTERN,
		});
		const updatedAt = yield* tryProfileSync(() =>
			writeSyncCache(
				resultCacheKey(context, options, effectivePrompt.promptHash),
				{
					analysis: analysisResponse.value,
					markdown: analysisResponse.markdown,
					model: modelFromOptions(options),
					reasoningEffort: reasoningEffortFromOptions(options),
					serviceTier: serviceTierFromOptions(options),
					parseStatus: analysisResponse.parseStatus,
				} satisfies {
					analysis: ProfileAnalysis;
					markdown: string;
					model: string;
					reasoningEffort: string;
					serviceTier: string;
					parseStatus: "structured" | "fallback";
				},
			),
		);
		const result: ProfileAnalysisRunResult = {
			context,
			analysis: analysisResponse.value,
			markdown: analysisResponse.markdown,
			model: modelFromOptions(options),
			reasoningEffort: reasoningEffortFromOptions(options),
			serviceTier: serviceTierFromOptions(options),
			parseStatus: analysisResponse.parseStatus,
			cached: false,
			updatedAt,
		};
		handlers.onDelta?.(result.markdown);
		handlers.onEvent?.({ type: "delta", delta: result.markdown });
		handlers.onEvent?.({ type: "done", result });
		return result;
	});
}

export function streamProfileAnalysis(
	options: ProfileAnalysisOptions,
	handlers: ProfileAnalysisStreamHandlers = {},
) {
	return runEffectPromise(streamProfileAnalysisEffect(options, handlers));
}

export function runProfileAnalysisPlaygroundEffect(
	options: ProfileAnalysisPlaygroundOptions,
): Effect.Effect<ProfileAnalysisPlaygroundResult, Error> {
	return Effect.gen(function* () {
		const effectivePrompt = yield* tryProfileSync(() =>
			materializeEffectivePrompt(
				{ system: options.system, requirements: options.requirements },
				PROMPT_TEMPLATE_DEFINITIONS["profile-analysis"].protocol,
			),
		);
		const runOptions: ProfileAnalysisOptions = {
			handle: options.handle,
			account: options.account,
			language: options.language,
			signal: options.signal,
		};
		const context = yield* tryProfileSync(() =>
			collectProfileAnalysisContextLocalOnly(runOptions),
		);
		if (context.tweets.length === 0 && context.conversations.length === 0) {
			return yield* Effect.fail(
				new Error("本地数据为空：该账号没有可供测试的推文或会话。"),
			);
		}
		const response = yield* requestHybridAnalysisEffect({
			body: createOpenAIRequestBody(context, runOptions, effectivePrompt),
			signal: options.signal,
			parse: (value) => ProfileAnalysisSchema.parse(value),
			fallback: (markdown) => fallbackAnalysis(context, markdown),
			delimiterPattern: DELIMITER_PATTERN,
		});
		return {
			markdown: response.markdown,
			analysis: response.value,
			parseStatus: response.parseStatus,
			generatedAt: new Date().toISOString(),
		};
	});
}

export function runProfileAnalysisPlayground(
	options: ProfileAnalysisPlaygroundOptions,
) {
	return runEffectPromise(runProfileAnalysisPlaygroundEffect(options));
}

export const __test__ = {
	ProfileAnalysisSchema,
	buildPrompt,
	collectProfileAnalysisContextLocalOnly,
	createOpenAIRequestBody,
	extractResponseText,
	parseAnalysisFromHybridText,
	resultCacheKey,
};
