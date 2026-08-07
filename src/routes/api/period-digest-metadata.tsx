import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	isFreshDigestCache,
	normalizePeriod,
	type PeriodDigestContentSource,
	type PeriodDigestRunResult,
} from "#/lib/period-digest";
import { isDisplayablePeriodDigest } from "#/lib/period-digest-integrity";
import {
	migrateLegacyPeriodDigests,
	readCurrentPeriodDigest,
	type CurrentPeriodDigestV1,
} from "#/lib/period-digest-current-store";
import {
	PERIOD_DIGEST_LOCK_STALE_MS,
	periodDigestRunLockPath,
	readPeriodDigestRunState,
	type PeriodDigestRunStateV1,
} from "#/lib/period-digest-orchestrator";
import { parsePeriodDigestRequestOptions } from "#/lib/period-digest-request";
import { peekScheduledJobLockEffect } from "#/lib/scheduled-job";

const legacyMigrationAttemptedKeys = new Set<string>();

function migrationKey(
	period: "today" | "24h",
	contentSource: PeriodDigestContentSource,
) {
	return `${period}:${contentSource}`;
}

export function resetPeriodDigestMetadataMigrationForTests() {
	legacyMigrationAttemptedKeys.clear();
}

function resultFromCurrent(
	current: CurrentPeriodDigestV1 | null,
): PeriodDigestRunResult | null {
	if (!current || !isDisplayablePeriodDigest(current)) return null;
	return {
		context: current.context,
		digest: current.digest,
		markdown: current.markdown,
		model: current.model,
		reasoningEffort: current.reasoningEffort,
		serviceTier: current.serviceTier,
		parseStatus: current.parseStatus,
		cached: true,
		updatedAt: current.generatedAt,
	};
}

function sourceLabel(source: PeriodDigestContentSource | undefined) {
	if (source === "for_you") return "For You";
	if (source === "following") return "Following";
	if (source === "all") return "All";
	return undefined;
}

function activeStatus(state: PeriodDigestRunStateV1 | undefined) {
	if (!state) return null;
	const completed = Object.values(state.sources).filter(
		(source) => source.state === "completed",
	).length;
	if (state.phase === "syncing") {
		return {
			label: "Refreshing information sources",
			detail: "Preparing batch",
		};
	}
	if (state.phase === "preparing") {
		return { label: "Preparing current digest", detail: "Freezing sources" };
	}
	if (state.phase === "generating") {
		const current = sourceLabel(state.currentSource);
		return {
			label: "Generating current digest",
			detail: `${String(completed)}/3 complete${current ? ` · ${current}` : ""}`,
		};
	}
	return null;
}

export const Route = createFileRoute("/api/period-digest-metadata")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const options = parsePeriodDigestRequestOptions(
							new URL(request.url),
						);
						const period = normalizePeriod(options.period);
						if (period !== "today" && period !== "24h") {
							return jsonResponse(
								{
									ok: false,
									error: "Current digest state supports Today and 24h",
								},
								{ status: 400 },
							);
						}
						const contentSource = options.contentSource ?? "all";
						const recoveryKey = migrationKey(period, contentSource);
						let current = readCurrentPeriodDigest(period, contentSource);
						let result = resultFromCurrent(current);
						let migration = null;
						if (result) {
							legacyMigrationAttemptedKeys.delete(recoveryKey);
						} else if (!legacyMigrationAttemptedKeys.has(recoveryKey)) {
							legacyMigrationAttemptedKeys.add(recoveryKey);
							migration = migrateLegacyPeriodDigests();
							current = readCurrentPeriodDigest(period, contentSource);
							result = resultFromCurrent(current);
							if (result) legacyMigrationAttemptedKeys.delete(recoveryKey);
						}
						const isStale = result
							? !isFreshDigestCache(result.updatedAt, period)
							: true;
						const runState = yield* Effect.tryPromise({
							try: () => readPeriodDigestRunState(period),
							catch: (error) => error,
						});
						const lockActive = yield* peekScheduledJobLockEffect(
							periodDigestRunLockPath(period),
							PERIOD_DIGEST_LOCK_STALE_MS,
						);
						const isGenerating = Boolean(
							lockActive &&
							runState &&
							!["completed", "degraded", "failed"].includes(runState.phase),
						);
						return jsonResponse({
							ok: true,
							isGenerating,
							isStale,
							activeStatus: isGenerating ? activeStatus(runState) : null,
							result,
							runState: runState ?? null,
							migration,
						});
					}),
				),
		},
	},
});
