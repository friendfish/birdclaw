import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resolveDigestArchiveDir } from "#/lib/config";
import { readDigestArchiveEntryEffect } from "#/lib/digest-archive-job";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import type {
	PeriodDigestContentSource,
	PeriodDigestPreset,
} from "#/lib/period-digest";

function parsePeriod(value: string | null): PeriodDigestPreset {
	return value === "yesterday" || value === "week" ? value : "yesterday";
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
						const period = parsePeriod(url.searchParams.get("period"));
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
