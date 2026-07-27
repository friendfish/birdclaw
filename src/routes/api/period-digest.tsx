import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { periodDigestStreamEventSchema } from "#/lib/client-stream-contracts";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import { getBirdclawConfig } from "#/lib/config";
import {
	DEFAULT_LOCK_STALE_MS,
	digestArchiveLockPath,
} from "#/lib/digest-archive-job";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createEffectNdjsonResponse } from "#/lib/ndjson-stream";
import {
	normalizeDigestLanguage,
	normalizePeriod,
	streamPeriodDigestEffect,
	type PeriodDigestContentSource,
	type PeriodDigestOptions,
	type PeriodDigestStreamEvent,
} from "#/lib/period-digest";
import { peekScheduledJobLockEffect } from "#/lib/scheduled-job";

function parseBoolean(value: string | null) {
	return value === "true" || value === "1" || value === "yes";
}

function parseContentSource(value: string | null): PeriodDigestContentSource {
	return value === "for_you" || value === "following" ? value : "all";
}

function parseOptions(url: URL): PeriodDigestOptions {
	return {
		period: url.searchParams.get("period") ?? undefined,
		since: url.searchParams.get("since") ?? undefined,
		until: url.searchParams.get("until") ?? undefined,
		account: url.searchParams.get("account") ?? undefined,
		includeDms: parseBoolean(url.searchParams.get("includeDms")),
		contentSource: parseContentSource(url.searchParams.get("contentSource")),
		refresh: parseBoolean(url.searchParams.get("refresh")),
		model: url.searchParams.get("model") === "gpt-5.5" ? "gpt-5.5" : undefined,
		language: normalizeDigestLanguage(
			url.searchParams.get("language") ?? undefined,
		),
		maxTweets: parseBoundedInteger(url.searchParams.get("maxTweets"), {
			max: 5_000,
		}),
		maxLinks: parseBoundedInteger(url.searchParams.get("maxLinks"), {
			max: 25,
		}),
		liveSync: url.searchParams.get("liveSync") !== "false",
		liveSyncMode:
			getBirdclawConfig().mentions?.dataSource === "bird" ? "bird" : "xurl",
		liveTimelineLimit: parseBoundedInteger(
			url.searchParams.get("liveTimelineLimit"),
			{ max: 100_000 },
		),
		liveTimelineMaxPages: parseBoundedInteger(
			url.searchParams.get("liveTimelineMaxPages"),
			{ max: 1_000 },
		),
	};
}

export const Route = createFileRoute("/api/period-digest")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						let options: PeriodDigestOptions;
						try {
							options = parseOptions(url);
						} catch (error) {
							return jsonResponse(
								{
									ok: false,
									error: error instanceof Error ? error.message : String(error),
								},
								{ status: 400 },
							);
						}
						return createEffectNdjsonResponse<PeriodDigestStreamEvent>({
							request,
							schema: periodDigestStreamEventSchema,
							initialEvents: [
								{
									type: "status",
									label: "Preparing local archive",
									detail: "Checking for backup updates.",
								},
							],
							run: ({ signal, emit }) =>
								Effect.gen(function* () {
									// A scheduled digest-archive job holds this lock for the
									// whole run — defer to it rather than racing a second
									// generation for the same period (background job wins;
									// see the design discussion in PR #31 / issue #30).
									const period = normalizePeriod(options.period);
									const isArchiving = yield* peekScheduledJobLockEffect(
										digestArchiveLockPath(period),
										DEFAULT_LOCK_STALE_MS,
									);
									if (isArchiving) {
										emit({
											type: "error",
											error:
												"This period is currently being generated in the background. Try again shortly.",
										});
										return;
									}
									yield* maybeAutoUpdateBackupEffect();
									return yield* streamPeriodDigestEffect(
										{ ...options, signal },
										{ onEvent: emit },
									);
								}),
							errorEvent: (error) => ({
								type: "error",
								error: error instanceof Error ? error.message : "Digest failed",
							}),
						});
					}),
				),
		},
	},
});
