import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";

const sourceRunSchema = z.object({
	state: z.enum(["pending", "running", "completed", "failed"]),
	attempts: z.number().int().nonnegative(),
	generatedAt: z.string().optional(),
	error: z.string().optional(),
});

const digestArchiveStatusResponseSchema = z.object({
	ok: z.boolean(),
	runningPeriods: z.array(z.string()),
	activeRuns: z
		.array(
			z.object({
				period: z.string(),
				runDate: z.string(),
				totalSources: z.number().int().positive().default(3),
				phase: z
					.enum(["pre-sync", "generating", "finalizing"])
					.default("generating"),
				currentSource: z.string().optional(),
				startedAt: z.string().default(""),
				lastHeartbeatAt: z.string().default(""),
				sources: z.record(z.string(), sourceRunSchema).default({}),
			}),
		)
		.default([]),
	lastRuns: z
		.array(
			z.object({
				period: z.string(),
				runDate: z.string(),
				status: z.enum(["ok", "degraded", "failed"]),
				finishedAt: z.string(),
				sources: z.record(z.string(), sourceRunSchema).default({}),
			}),
		)
		.default([]),
});

const STATUS_POLL_INTERVAL_MS = 2_000;

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
		loading: query.isLoading,
		runningPeriods: new Set(query.data?.runningPeriods ?? []),
		activeRuns: new Map(
			(query.data?.activeRuns ?? []).map(({ period, ...run }) => [period, run]),
		),
		lastRuns: new Map(
			(query.data?.lastRuns ?? []).map(({ period, ...run }) => [period, run]),
		),
	};
}
