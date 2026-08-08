import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resolveDigestArchiveDir } from "#/lib/config";
import { listDigestArchiveDatesEffect } from "#/lib/digest-archive-job";
import {
	parseDigestArchivePeriod,
	type DigestArchivePeriod,
} from "#/lib/digest-archive-request";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

export const Route = createFileRoute("/api/digest-archive-dates")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						let period: DigestArchivePeriod;
						try {
							const url = new URL(request.url);
							period = parseDigestArchivePeriod(url.searchParams.get("period"));
						} catch (error) {
							return jsonResponse(
								{
									ok: false,
									error: error instanceof Error ? error.message : String(error),
								},
								{ status: 400 },
							);
						}
						const archiveDir = resolveDigestArchiveDir();
						const dates = yield* listDigestArchiveDatesEffect({
							archiveDir,
							period,
						});
						return jsonResponse({ ok: true, dates });
					}),
				),
		},
	},
});
