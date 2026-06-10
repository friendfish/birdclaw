import { randomUUID } from "node:crypto";
import { getNativeDb } from "./db";
import type { Database } from "./sqlite";
import { readSyncCache, writeSyncCache } from "./sync-cache";

export type XurlRateLimitEndpointKey =
	| "tweets_search_recent"
	| "users_id_tweets";

export type XurlRateLimitEventStatus = "ok" | "rate_limited" | "error";

export interface XurlRateLimitEvent {
	id: string;
	endpoint: XurlRateLimitEndpointKey;
	status: XurlRateLimitEventStatus;
	at: string;
	source: string;
	handle?: string;
	detail?: string;
}

export interface XurlRateLimitEndpointSnapshot {
	key: XurlRateLimitEndpointKey;
	label: string;
	method: string;
	path: string;
	description: string;
	perAppLimit: number;
	perUserLimit: number;
	windowMs: number;
	callsLastWindow: number;
	estimatedRemaining: number;
	usagePercent: number;
	rateLimitedLastWindow: number;
	errorsLastWindow: number;
	lastEventAt: string | null;
	lastRateLimitAt: string | null;
	estimatedResetAt: string | null;
	status: "healthy" | "warning" | "critical" | "quiet";
}

export interface XurlRateLimitSnapshot {
	generatedAt: string;
	windowMs: number;
	docsUrl: string;
	summary: {
		totalCallsLastWindow: number;
		rateLimitedLastWindow: number;
		errorLastWindow: number;
		criticalEndpoints: number;
		lastEventAt: string | null;
	};
	endpoints: XurlRateLimitEndpointSnapshot[];
	events: XurlRateLimitEvent[];
	throttle: {
		conversationDelayMs: number;
		rateLimitRetryMs: number;
		rateLimitMaxRetries: number;
	};
}

interface StoredXurlRateLimitEvents {
	events: XurlRateLimitEvent[];
}

export const XURL_RATE_LIMIT_DOCS_URL =
	"https://docs.x.com/x-api/fundamentals/rate-limits";

const CACHE_KEY = "xurl:rate-limits";
const WINDOW_MS = 15 * 60_000;
const EVENT_RETENTION_MS = 24 * 60 * 60_000;
const MAX_EVENTS = 1_000;

const ENDPOINTS = [
	{
		key: "tweets_search_recent",
		label: "Recent search",
		method: "GET",
		path: "/2/tweets/search/recent",
		description: "Conversation backfill searches",
		perAppLimit: 450,
		perUserLimit: 300,
		windowMs: WINDOW_MS,
	},
	{
		key: "users_id_tweets",
		label: "User tweets",
		method: "GET",
		path: "/2/users/:id/tweets",
		description: "Profile timeline pages",
		perAppLimit: 10_000,
		perUserLimit: 900,
		windowMs: WINDOW_MS,
	},
] as const;

function envNonNegativeInteger(name: string, fallback: number) {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return fallback;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) return fallback;
	return Math.floor(numeric);
}

function readStoredEvents(db: Database): XurlRateLimitEvent[] {
	const stored = readSyncCache<StoredXurlRateLimitEvents>(CACHE_KEY, db);
	if (!stored || !Array.isArray(stored.value.events)) return [];
	return stored.value.events.filter((event) => {
		return (
			typeof event.id === "string" &&
			typeof event.at === "string" &&
			typeof event.source === "string" &&
			(event.status === "ok" ||
				event.status === "rate_limited" ||
				event.status === "error") &&
			ENDPOINTS.some((endpoint) => endpoint.key === event.endpoint)
		);
	});
}

function eventTime(event: XurlRateLimitEvent) {
	const time = new Date(event.at).getTime();
	return Number.isFinite(time) ? time : 0;
}

function retainEvents(events: XurlRateLimitEvent[], nowMs: number) {
	return events
		.filter((event) => eventTime(event) >= nowMs - EVENT_RETENTION_MS)
		.sort((left, right) => eventTime(right) - eventTime(left))
		.slice(0, MAX_EVENTS);
}

export function recordXurlRateLimitEvent(
	input: Omit<XurlRateLimitEvent, "id" | "at"> & { at?: string },
	db = getNativeDb(),
) {
	const now = input.at ?? new Date().toISOString();
	const nowMs = new Date(now).getTime();
	const event: XurlRateLimitEvent = {
		id: randomUUID(),
		at: now,
		endpoint: input.endpoint,
		status: input.status,
		source: input.source,
		...(input.handle ? { handle: input.handle } : {}),
		...(input.detail ? { detail: input.detail.slice(0, 500) } : {}),
	};
	const events = retainEvents([event, ...readStoredEvents(db)], nowMs);
	writeSyncCache(CACHE_KEY, { events }, db);
	return event;
}

export function recordXurlRateLimitEventSafe(
	input: Omit<XurlRateLimitEvent, "id" | "at"> & { at?: string },
	db = getNativeDb(),
) {
	try {
		recordXurlRateLimitEvent(input, db);
	} catch {
		// Rate-limit observability must never break the xurl workflow itself.
	}
}

function classifyEndpoint(args: {
	calls: number;
	limit: number;
	rateLimited: number;
	errors: number;
}) {
	const usage = args.limit > 0 ? args.calls / args.limit : 0;
	if (args.calls === 0 && args.errors === 0 && args.rateLimited === 0) {
		return "quiet";
	}
	if (args.rateLimited > 0 || usage >= 0.9) return "critical";
	if (args.errors > 0 || usage >= 0.7) return "warning";
	return "healthy";
}

export function getXurlRateLimitSnapshot(
	db = getNativeDb(),
	now = new Date(),
): XurlRateLimitSnapshot {
	const nowMs = now.getTime();
	const events = retainEvents(readStoredEvents(db), nowMs);
	const windowStart = nowMs - WINDOW_MS;
	const windowEvents = events.filter(
		(event) => eventTime(event) >= windowStart,
	);
	const endpoints = ENDPOINTS.map((endpoint) => {
		const endpointEvents = windowEvents.filter(
			(event) => event.endpoint === endpoint.key,
		);
		const allEndpointEvents = events.filter(
			(event) => event.endpoint === endpoint.key,
		);
		const calls = endpointEvents.length;
		const rateLimited = endpointEvents.filter(
			(event) => event.status === "rate_limited",
		).length;
		const errors = endpointEvents.filter(
			(event) => event.status === "error",
		).length;
		const oldestInWindow = endpointEvents.at(-1);
		const estimatedResetAt = oldestInWindow
			? new Date(eventTime(oldestInWindow) + WINDOW_MS).toISOString()
			: null;
		const lastRateLimit = allEndpointEvents.find(
			(event) => event.status === "rate_limited",
		);
		const status = classifyEndpoint({
			calls,
			limit: endpoint.perUserLimit,
			rateLimited,
			errors,
		});
		return {
			...endpoint,
			callsLastWindow: calls,
			estimatedRemaining: Math.max(0, endpoint.perUserLimit - calls),
			usagePercent:
				endpoint.perUserLimit > 0
					? Math.min(100, Math.round((calls / endpoint.perUserLimit) * 100))
					: 0,
			rateLimitedLastWindow: rateLimited,
			errorsLastWindow: errors,
			lastEventAt: allEndpointEvents[0]?.at ?? null,
			lastRateLimitAt: lastRateLimit?.at ?? null,
			estimatedResetAt,
			status,
		} satisfies XurlRateLimitEndpointSnapshot;
	});

	const lastEventAt = events[0]?.at ?? null;
	return {
		generatedAt: now.toISOString(),
		windowMs: WINDOW_MS,
		docsUrl: XURL_RATE_LIMIT_DOCS_URL,
		summary: {
			totalCallsLastWindow: windowEvents.length,
			rateLimitedLastWindow: windowEvents.filter(
				(event) => event.status === "rate_limited",
			).length,
			errorLastWindow: windowEvents.filter((event) => event.status === "error")
				.length,
			criticalEndpoints: endpoints.filter(
				(endpoint) => endpoint.status === "critical",
			).length,
			lastEventAt,
		},
		endpoints,
		events: events.slice(0, 80),
		throttle: {
			conversationDelayMs: envNonNegativeInteger(
				"BIRDCLAW_PROFILE_ANALYSIS_CONVERSATION_DELAY_MS",
				3_100,
			),
			rateLimitRetryMs: envNonNegativeInteger(
				"BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_RETRY_MS",
				60_000,
			),
			rateLimitMaxRetries: envNonNegativeInteger(
				"BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_MAX_RETRIES",
				1,
			),
		},
	};
}
