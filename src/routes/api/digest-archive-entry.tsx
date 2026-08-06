import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resolveDigestArchiveDir } from "#/lib/config";
import { readDigestArchiveEntryEffect } from "#/lib/digest-archive-job";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import type { PeriodDigestContentSource } from "#/lib/period-digest";

function parsePeriod(value: string | null): "yesterday" | "week" {
	return value === "week" ? "week" : "yesterday";
}

function currentPeriodError(value: string | null) {
	return value === "today" || value === "24h";
}

function parseContentSource(value: string | null): PeriodDigestContentSource {
	return value === "for_you" || value === "following" ? value : "all";
}

export const Route = createFileRoute("/api/digest-archive-entry")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const requestedPeriod = url.searchParams.get("period");
						if (currentPeriodError(requestedPeriod)) {
							return jsonResponse(
								{
									ok: false,
									error:
										"Today and 24h are current views and do not have archives.",
								},
								{ status: 400 },
							);
						}
						const period = parsePeriod(requestedPeriod);
						const contentSource = parseContentSource(
							url.searchParams.get("contentSource"),
						);
						const date = url.searchParams.get("date") ?? "";
						const archiveDir = resolveDigestArchiveDir();
						const entry = yield* readDigestArchiveEntryEffect({
							archiveDir,
							period,
							contentSource,
							date,
						});
						if (!entry) {
							// 200, not 404: "no archive for this exact combination" is a
							// normal, expected outcome (e.g. before the first scheduled
							// run, or a content source that failed that day) — the
							// client's fetchJson treats any non-2xx as a hard failure, so
							// this has to stay a successful response with result: null.
							return jsonResponse({ ok: true, result: null });
						}
						return jsonResponse({
							ok: true,
							result: {
								context: entry.context,
								digest: entry.digest,
								markdown: entry.markdown,
								model: entry.model,
								reasoningEffort: entry.reasoningEffort,
								serviceTier: entry.serviceTier,
								cached: entry.cached,
								updatedAt: entry.generatedAt,
							},
						});
					}),
				),
		},
	},
});
