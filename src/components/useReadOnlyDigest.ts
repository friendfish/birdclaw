import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type {
	PeriodDigestContentSource,
	PeriodDigestContext,
	PeriodDigestRunResult,
} from "#/lib/period-digest";
import type { PeriodRouteSearch } from "#/lib/route-search";

const digestArchiveDatesResponseSchema = z.object({
	ok: z.boolean(),
	dates: z.array(
		z.object({
			date: z.string(),
			contentSources: z.array(z.string()),
		}),
	),
});

const digestArchiveEntryResponseSchema = z.object({
	ok: z.boolean(),
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

export interface DigestArchiveDateOption {
	date: string;
	contentSources: PeriodDigestContentSource[];
}

/** Only meaningful for the "yesterday"/"week" periods — Today/24h stay live. */
export function useDigestArchiveDates(
	period: PeriodRouteSearch,
	enabled: boolean,
) {
	return useQuery({
		queryKey: [...queryKeys.digestArchiveDates, period],
		queryFn: () =>
			fetchJson(
				`/api/digest-archive-dates?period=${period}`,
				undefined,
				digestArchiveDatesResponseSchema,
				"Failed to load archived dates",
			),
		enabled,
	});
}

export function useReadOnlyDigest({
	period,
	contentSource,
	archiveDate,
	enabled,
}: {
	period: PeriodRouteSearch;
	contentSource: PeriodDigestContentSource;
	archiveDate: string;
	enabled: boolean;
}) {
	const datesQuery = useDigestArchiveDates(period, enabled);
	const dates = (datesQuery.data?.dates ?? []) as DigestArchiveDateOption[];
	const effectiveDate = archiveDate || dates[0]?.date;

	const entryQuery = useQuery({
		queryKey: [
			...queryKeys.digestArchiveEntry,
			period,
			contentSource,
			effectiveDate,
		],
		queryFn: () =>
			fetchJson(
				`/api/digest-archive-entry?period=${period}&contentSource=${contentSource}&date=${effectiveDate}`,
				undefined,
				digestArchiveEntryResponseSchema,
				"Failed to load archived digest",
			),
		enabled: enabled && Boolean(effectiveDate),
	});

	const result = (entryQuery.data?.result ??
		null) as PeriodDigestRunResult | null;
	const loading = enabled && (datesQuery.isLoading || entryQuery.isLoading);
	const error = datesQuery.error ?? entryQuery.error;

	function retry() {
		void datesQuery.refetch();
		void entryQuery.refetch();
	}

	return {
		context: (result?.context ?? null) as PeriodDigestContext | null,
		markdown: result?.markdown ?? "",
		result,
		loading,
		error: error
			? error instanceof Error
				? error.message
				: String(error)
			: null,
		retry,
		dates,
		effectiveDate,
		// Distinguishes "this period has never been archived at all" (no
		// dates exist yet) from "this date exists but this content source
		// wasn't archived that day" (dates exist, but the fetched entry for
		// the resolved date+contentSource came back null).
		neverArchived: !datesQuery.isLoading && dates.length === 0,
	};
}
