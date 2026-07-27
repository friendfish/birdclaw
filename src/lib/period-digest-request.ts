import { getBirdclawConfig } from "./config";
import { parseBoundedInteger } from "./http-effect";
import {
	normalizeDigestLanguage,
	type PeriodDigestContentSource,
	type PeriodDigestOptions,
} from "./period-digest";

function parseBoolean(value: string | null) {
	return value === "true" || value === "1" || value === "yes";
}

function parseContentSource(value: string | null): PeriodDigestContentSource {
	return value === "for_you" || value === "following" ? value : "all";
}

/**
 * Shared by /api/period-digest and /api/period-digest-metadata so both
 * routes derive byte-identical PeriodDigestOptions from the same query
 * params — required for latestDigestCacheKey(options) to compute the same
 * cache/registry key on both sides.
 */
export function parsePeriodDigestRequestOptions(url: URL): PeriodDigestOptions {
	return {
		period: url.searchParams.get("period") ?? undefined,
		since: url.searchParams.get("since") ?? undefined,
		until: url.searchParams.get("until") ?? undefined,
		account: url.searchParams.get("account") ?? undefined,
		includeDms: parseBoolean(url.searchParams.get("includeDms")),
		contentSource: parseContentSource(url.searchParams.get("contentSource")),
		refresh: parseBoolean(url.searchParams.get("refresh")),
		model: url.searchParams.get("model") === "gpt-5.5" ? "gpt-5.5" : undefined,
		language: normalizeDigestLanguage(
			url.searchParams.get("language") ?? undefined,
		),
		maxTweets: parseBoundedInteger(url.searchParams.get("maxTweets"), {
			max: 5_000,
		}),
		maxLinks: parseBoundedInteger(url.searchParams.get("maxLinks"), {
			max: 25,
		}),
		liveSync: url.searchParams.get("liveSync") !== "false",
		liveSyncMode:
			getBirdclawConfig().mentions?.dataSource === "bird" ? "bird" : "xurl",
		liveTimelineLimit: parseBoundedInteger(
			url.searchParams.get("liveTimelineLimit"),
			{ max: 100_000 },
		),
		liveTimelineMaxPages: parseBoundedInteger(
			url.searchParams.get("liveTimelineMaxPages"),
			{ max: 1_000 },
		),
	};
}
