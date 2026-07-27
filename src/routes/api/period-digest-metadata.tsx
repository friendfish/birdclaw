import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	activePeriodDigestsRegistry,
	periodDigestRegistryKey,
} from "#/lib/period-digest-active-registry";
import {
	isFreshDigestCache,
	latestDigestCacheKey,
	type CachedPeriodDigestValue,
	type PeriodDigestRunResult,
} from "#/lib/period-digest";
import { parsePeriodDigestRequestOptions } from "#/lib/period-digest-request";
import { readSyncCache } from "#/lib/sync-cache";

export const Route = createFileRoute("/api/period-digest-metadata")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const options = parsePeriodDigestRequestOptions(url);
						const registryKey = periodDigestRegistryKey(options);

						const registry = activePeriodDigestsRegistry();
						const isGenerating = registry.has(registryKey);
						const activeStatus = registry.get(registryKey) ?? null;

						// A different key from the registry's on purpose — this one
						// embeds the *current* model/language/reasoningEffort/
						// serviceTier config, matching how streamPeriodDigestEffect
						// itself keys the "latest" sync_cache row it writes.
						const resultCacheKey = latestDigestCacheKey(options);
						const cached =
							readSyncCache<CachedPeriodDigestValue>(resultCacheKey);
						const cachedUpdatedAt =
							cached?.value.updatedAt ?? cached?.updatedAt;
						const isFresh = Boolean(
							cached &&
							cachedUpdatedAt &&
							isFreshDigestCache(cachedUpdatedAt, options.period),
						);
						const result: PeriodDigestRunResult | null =
							cached && isFresh && cached.value.context
								? {
										context: cached.value.context,
										digest: cached.value.digest,
										markdown: cached.value.markdown,
										model: cached.value.model,
										reasoningEffort: cached.value.reasoningEffort,
										serviceTier: cached.value.serviceTier,
										cached: true,
										updatedAt: cachedUpdatedAt ?? cached.updatedAt,
									}
								: null;

						return jsonResponse({
							ok: true,
							isGenerating,
							activeStatus,
							result,
						});
					}),
				),
		},
	},
});
