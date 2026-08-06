import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { periodDigestStreamEventSchema } from "#/lib/client-stream-contracts";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import {
	DEFAULT_LOCK_STALE_MS,
	digestArchiveLockPath,
} from "#/lib/digest-archive-job";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createEffectNdjsonResponse } from "#/lib/ndjson-stream";
import {
	activePeriodDigestsRegistry,
	periodDigestRegistryKey,
} from "#/lib/period-digest-active-registry";
import { parsePeriodDigestRequestOptions } from "#/lib/period-digest-request";
import {
	normalizePeriod,
	streamPeriodDigestEffect,
	type PeriodDigestOptions,
	type PeriodDigestStreamEvent,
} from "#/lib/period-digest";
import { peekScheduledJobLockEffect } from "#/lib/scheduled-job";

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
							options = parsePeriodDigestRequestOptions(url);
						} catch (error) {
							return jsonResponse(
								{
									ok: false,
									error: error instanceof Error ? error.message : String(error),
								},
								{ status: 400 },
							);
						}
						const period = normalizePeriod(options.period);
						if (period === "today" || period === "24h") {
							return jsonResponse(
								{
									ok: false,
									error:
										"Today/24h generation requires POST /api/period-digest-runs",
								},
								{ status: 405, headers: { allow: "POST" } },
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
							run: ({ emit }) =>
								Effect.gen(function* () {
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

									const registry = activePeriodDigestsRegistry();
									const registryKey = periodDigestRegistryKey(options);
									registry.set(registryKey, {
										label: "Preparing local archive",
									});
									const wrappedEmit = (event: PeriodDigestStreamEvent) => {
										if (event.type === "status") {
											registry.set(registryKey, {
												label: event.label,
												detail: event.detail,
											});
										} else if (event.type === "start") {
											registry.set(registryKey, {
												label: "Streaming AI summary",
											});
										}
										emit(event);
									};

									yield* maybeAutoUpdateBackupEffect();
									const runDigest = Effect.gen(function* () {
										// Deliberately not the request's own AbortSignal: if the
										// client navigates away mid-generation, we want the
										// summarization (and its OpenAI call) to keep running
										// server-side and land in sync_cache rather than dying —
										// same "Option A" decoupling used by /api/profile-analysis.
										// A later poll of /api/period-digest-metadata picks up the
										// result instead of the client having to restart from
										// scratch. See issue discussion for the background.
										return yield* streamPeriodDigestEffect(
											{ ...options, signal: undefined },
											{ onEvent: wrappedEmit },
										);
									});
									return yield* Effect.ensuring(
										runDigest,
										Effect.sync(() => {
											registry.delete(registryKey);
										}),
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
