import type { PeriodDigestContentSource } from "./period-digest";

/**
 * Shared by today.tsx's digestUrl() and usePeriodDigestMetadata.ts's
 * metadataUrl() — both must send the exact same period/includeDms/
 * contentSource/maxTweets/maxLinks/liveSync values, since the server derives
 * its registry/cache key from these params. Structuring it as one function
 * both call (rather than two copies of the same literals) makes that
 * guarantee hold even if one side changes later.
 */
export function applyPeriodDigestIdentityParams(
	url: URL,
	period: string,
	includeDms: boolean,
	contentSource: PeriodDigestContentSource,
) {
	url.searchParams.set("period", period);
	url.searchParams.set("includeDms", String(includeDms));
	url.searchParams.set("contentSource", contentSource);
	url.searchParams.set("maxTweets", "5000");
	url.searchParams.set("maxLinks", "20");
	// Cloudflare caps proxied requests; live timeline sync remains a separate job/UI action.
	url.searchParams.set("liveSync", "false");
}
