import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
	running = false,
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
		refetchInterval: running ? 2_000 : false,
	});
}

export function useReadOnlyDigest({
	period,
	contentSource,
	archiveDate,
	enabled,
	running = false,
	activeRunDate,
}: {
	period: PeriodRouteSearch;
	contentSource: PeriodDigestContentSource;
	archiveDate: string;
	enabled: boolean;
	running?: boolean;
	activeRunDate?: string;
}) {
	const previousRunRef = useRef({ period, running: false });
	const lastActiveRunRef = useRef<
		{ period: PeriodRouteSearch; runDate: string } | undefined
	>(undefined);
	const [finalizingState, setFinalizingState] = useState({
		period,
		active: false,
	});
	if (running && activeRunDate) {
		lastActiveRunRef.current = { period, runDate: activeRunDate };
	}
	const previousRun = previousRunRef.current;
	const finishingTransition =
		previousRun.period === period && previousRun.running && !running;
	const finalizing =
		finalizingState.period === period && finalizingState.active;
	const polling = running || finalizing || finishingTransition;
	const datesQuery = useDigestArchiveDates(period, enabled, polling);
	const dates = (datesQuery.data?.dates ?? []) as DigestArchiveDateOption[];
	const currentRunDate =
		activeRunDate ||
		(polling && lastActiveRunRef.current?.period === period
			? lastActiveRunRef.current.runDate
			: undefined);
	const effectiveDate = archiveDate || currentRunDate || dates[0]?.date;
	const effectiveDateOption = dates.find(
		(option) => option.date === effectiveDate,
	);
	const completedSources = effectiveDateOption?.contentSources.length ?? 0;

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
		refetchInterval: polling ? 2_000 : false,
	});

	useEffect(() => {
		const previous = previousRunRef.current;
		previousRunRef.current = { period, running };
		if (previous.period !== period) {
			setFinalizingState({ period, active: false });
			return;
		}
		if (!previous.running || running) return;

		let cancelled = false;
		setFinalizingState({ period, active: true });
		void Promise.all([datesQuery.refetch(), entryQuery.refetch()]).finally(
			() => {
				if (!cancelled) setFinalizingState({ period, active: false });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [datesQuery.refetch, entryQuery.refetch, period, running]);

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
		completedSources,
		sourcePending: polling && !result,
		finalizing: finalizing || finishingTransition,
		// Distinguishes "this period has never been archived at all" (no
		// dates exist yet) from "this date exists but this content source
		// wasn't archived that day" (dates exist, but the fetched entry for
		// the resolved date+contentSource came back null).
		neverArchived: !datesQuery.isLoading && dates.length === 0,
	};
}
