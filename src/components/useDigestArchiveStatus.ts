import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";

const digestArchiveStatusResponseSchema = z.object({
	ok: z.boolean(),
	runningPeriods: z.array(z.string()),
});

const STATUS_POLL_INTERVAL_MS = 5000;

/** Which periods (if any) currently have a scheduled archive job in flight —
 * used to grey out Today/24h's manual refresh button so it doesn't race the
 * background job for the same period (server-side enforces this too, see
 * the /api/period-digest mutex check; this is just the client-facing UX). */
export function useDigestArchiveRunningPeriods() {
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
	return new Set(query.data?.runningPeriods ?? []);
}
