import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";

const digestArchiveStatusResponseSchema = z.object({
	ok: z.boolean(),
	runningPeriods: z.array(z.string()),
	activeRuns: z
		.array(z.object({ period: z.string(), runDate: z.string() }))
		.default([]),
});

const STATUS_POLL_INTERVAL_MS = 2000;

/** Which periods (if any) currently have a scheduled archive job in flight —
 * used to grey out Today/24h's manual refresh button so it doesn't race the
 * background job for the same period (server-side enforces this too, see
 * the /api/period-digest mutex check; this is just the client-facing UX). */
export function useDigestArchiveStatus() {
	const query = useQuery({
		queryKey: queryKeys.digestArchiveStatus,
		queryFn: () =>
			fetchJson(
				"/api/digest-archive-status",
				undefined,
				digestArchiveStatusResponseSchema,
				"Digest archive status failed",
			),
		refetchInterval: STATUS_POLL_INTERVAL_MS,
	});
	return {
		runningPeriods: new Set(query.data?.runningPeriods ?? []),
		activeRunDates: new Map(
			(query.data?.activeRuns ?? []).map(({ period, runDate }) => [
				period,
				runDate,
			]),
		),
	};
}
