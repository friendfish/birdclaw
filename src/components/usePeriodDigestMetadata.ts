import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type {
	PeriodDigestContentSource,
	PeriodDigestRunResult,
} from "#/lib/period-digest";
import { applyPeriodDigestIdentityParams } from "#/lib/period-digest-url";

const POLL_INTERVAL_MS = 3000;

const periodDigestMetadataResponseSchema = z.object({
	ok: z.boolean(),
	isGenerating: z.boolean(),
	isStale: z.boolean(),
	activeStatus: z
		.object({ label: z.string(), detail: z.string().optional() })
		.nullable(),
	result: z
		.object({
			context: z.looseObject({}),
			digest: z.looseObject({}),
			markdown: z.string(),
			model: z.string(),
			reasoningEffort: z.string(),
			serviceTier: z.string(),
			parseStatus: z.enum(["structured", "fallback"]),
			cached: z.boolean(),
			updatedAt: z.string(),
		})
		.nullable(),
	runState: z.looseObject({}).nullable(),
	migration: z.unknown().nullable(),
});

function metadataUrl(period: string, contentSource: PeriodDigestContentSource) {
	const url = new URL("/api/period-digest-metadata", window.location.origin);
	applyPeriodDigestIdentityParams(url, period, false, contentSource);
	return url.toString();
}

/**
 * Lets the Today page discover a period digest that's already generating (or
 * just finished) in the background — e.g. because the user navigated away
 * mid-generation and came back — instead of blindly starting a duplicate
 * run. Polls while generating, same pattern as profile-analyze's metadata
 * polling.
 */
export function usePeriodDigestMetadata({
	period,
	contentSource,
	enabled,
}: {
	period: string;
	contentSource: PeriodDigestContentSource;
	enabled: boolean;
}) {
	const query = useQuery({
		queryKey: [...queryKeys.periodDigestMetadata, period, contentSource],
		queryFn: () =>
			fetchJson(
				metadataUrl(period, contentSource),
				undefined,
				periodDigestMetadataResponseSchema,
				"Failed to check digest status",
			),
		enabled,
		refetchInterval: (currentQuery) =>
			currentQuery.state.data?.isGenerating ? POLL_INTERVAL_MS : false,
	});
	const attemptedFreshnessKey = useRef<string | null>(null);
	const freshnessMutation = useMutation({
		mutationFn: async () => {
			const url = new URL(
				"/api/period-digest-freshness",
				window.location.origin,
			);
			url.searchParams.set("period", period);
			const response = await fetch(url, { method: "POST", cache: "no-store" });
			if (!response.ok) {
				throw new Error(
					`Freshness request failed (${String(response.status)})`,
				);
			}
		},
		onSuccess: () => {
			void query.refetch();
		},
	});
	const freshnessKey = `${period}:${contentSource}:${query.data?.result?.updatedAt ?? "empty"}`;
	useEffect(() => {
		if (
			!enabled ||
			query.isLoading ||
			!query.data?.isStale ||
			query.data.isGenerating ||
			freshnessMutation.isPending ||
			attemptedFreshnessKey.current === freshnessKey
		) {
			return;
		}
		attemptedFreshnessKey.current = freshnessKey;
		freshnessMutation.mutate();
	}, [
		enabled,
		freshnessKey,
		freshnessMutation,
		query.data?.isGenerating,
		query.data?.isStale,
		query.isLoading,
	]);

	return {
		isLoading: query.isLoading,
		isGenerating: query.data?.isGenerating ?? false,
		isStale: query.data?.isStale ?? false,
		activeStatus: query.data?.activeStatus ?? null,
		runState: query.data?.runState ?? null,
		result: (query.data?.result ?? null) as PeriodDigestRunResult | null,
		error: query.error ?? freshnessMutation.error,
		refetch: query.refetch,
	};
}
