import { useQuery } from "@tanstack/react-query";
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
			cached: z.boolean(),
			updatedAt: z.string(),
		})
		.nullable(),
});

function metadataUrl(
	period: string,
	includeDms: boolean,
	contentSource: PeriodDigestContentSource,
) {
	const url = new URL("/api/period-digest-metadata", window.location.origin);
	applyPeriodDigestIdentityParams(url, period, includeDms, contentSource);
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
	includeDms,
	contentSource,
	enabled,
}: {
	period: string;
	includeDms: boolean;
	contentSource: PeriodDigestContentSource;
	enabled: boolean;
}) {
	const query = useQuery({
		queryKey: [
			...queryKeys.periodDigestMetadata,
			period,
			includeDms,
			contentSource,
		],
		queryFn: () =>
			fetchJson(
				metadataUrl(period, includeDms, contentSource),
				undefined,
				periodDigestMetadataResponseSchema,
				"Failed to check digest status",
			),
		enabled,
		refetchInterval: (currentQuery) =>
			currentQuery.state.data?.isGenerating ? POLL_INTERVAL_MS : false,
	});

	return {
		isLoading: query.isLoading,
		isGenerating: query.data?.isGenerating ?? false,
		activeStatus: query.data?.activeStatus ?? null,
		result: (query.data?.result ?? null) as PeriodDigestRunResult | null,
		error: query.error,
		refetch: query.refetch,
	};
}
