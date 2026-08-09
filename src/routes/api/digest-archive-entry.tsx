import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resolveDigestArchiveDir } from "#/lib/config";
import { readDigestArchiveEntryEffect } from "#/lib/digest-archive-job";
import {
	digestArchiveRequestErrorMessage,
	parseDigestArchiveEntryRequest,
} from "#/lib/digest-archive-request";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

export const Route = createFileRoute("/api/digest-archive-entry")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						let options: ReturnType<typeof parseDigestArchiveEntryRequest>;
						try {
							options = parseDigestArchiveEntryRequest(url);
						} catch (error) {
							return jsonResponse(
								{
									ok: false,
									error: digestArchiveRequestErrorMessage(error),
								},
								{ status: 400 },
							);
						}
						const archiveDir = resolveDigestArchiveDir();
						const entry = yield* readDigestArchiveEntryEffect({
							archiveDir,
							...options,
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
