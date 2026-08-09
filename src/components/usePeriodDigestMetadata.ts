import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { fetchJson } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type {
	PeriodDigestContentSource,
	PeriodDigestRunResult,
} from "#/lib/period-digest";
import { applyPeriodDigestIdentityParams } from "#/lib/period-digest-url";

const ACTIVE_POLL_INTERVAL_MS = 3_000;
const IDLE_POLL_INTERVAL_MS = 30_000;

export function periodDigestMetadataPollInterval(isGenerating: boolean) {
	return isGenerating ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
}

const openAIStreamDiagnosticsSchema = z.strictObject({
	responseId: z.string().optional(),
	finishReason: z.string().optional(),
	visibleTextLength: z.number().finite().nonnegative(),
	reasoningTextLength: z.number().finite().nonnegative(),
});

export const periodDigestMetadataResponseSchema = z.object({
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
			diagnostics: openAIStreamDiagnosticsSchema.optional(),
			cached: z.boolean(),
			updatedAt: z.string(),
		})
		.nullable(),
	runState: z.looseObject({}).nullable(),
	migration: z.unknown().nullable(),
});

const periodDigestFreshnessResponseSchema = z.object({
	ok: z.boolean(),
	triggered: z.boolean(),
	reason: z.string().optional(),
	eligibleAt: z.string().optional(),
});

function metadataUrl(period: string, contentSource: PeriodDigestContentSource) {
	const url = new URL("/api/period-digest-metadata", window.location.origin);
	applyPeriodDigestIdentityParams(url, period, false, contentSource);
	return url.toString();
}

function terminalRunIdentity(runState: unknown) {
	if (!runState || typeof runState !== "object") return "no-run";
	const value = runState as Record<string, unknown>;
	if (
		typeof value.runId !== "string" ||
		typeof value.finishedAt !== "string" ||
		(value.phase !== "completed" &&
			value.phase !== "degraded" &&
			value.phase !== "failed")
	) {
		return "active-run";
	}
	return `${value.runId}:${value.finishedAt}:${value.phase}`;
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
			periodDigestMetadataPollInterval(
				Boolean(currentQuery.state.data?.isGenerating),
			),
		refetchOnWindowFocus: true,
	});
	const attemptedFreshnessKey = useRef<string | null>(null);
	const [freshnessEligibleAt, setFreshnessEligibleAt] = useState<string | null>(
		null,
	);
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
			return periodDigestFreshnessResponseSchema.parse(await response.json());
		},
		onSuccess: (result) => {
			setFreshnessEligibleAt(
				!result.triggered && result.reason === "not-due"
					? (result.eligibleAt ?? null)
					: null,
			);
			void query.refetch();
		},
	});
	useEffect(() => {
		if (!freshnessEligibleAt) return;
		const eligibleTime = new Date(freshnessEligibleAt).getTime();
		if (!Number.isFinite(eligibleTime)) {
			setFreshnessEligibleAt(null);
			return;
		}
		const remainingMs = eligibleTime - Date.now();
		const timeout = window.setTimeout(
			() => {
				attemptedFreshnessKey.current = null;
				setFreshnessEligibleAt(null);
			},
			remainingMs > 0 ? remainingMs + 50 : IDLE_POLL_INTERVAL_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [freshnessEligibleAt]);
	const freshnessKey = [
		period,
		contentSource,
		query.data?.result?.updatedAt ?? "empty",
		terminalRunIdentity(query.data?.runState),
	].join(":");
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
		freshnessEligibleAt,
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
