import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resolveDigestArchiveDir } from "#/lib/config";
import { listDigestArchiveDatesEffect } from "#/lib/digest-archive-job";
import {
	digestArchiveRequestErrorMessageOrRethrow,
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

						const url = new URL(request.url);
						let period: DigestArchivePeriod;
						try {
							period = parseDigestArchivePeriod(url.searchParams.get("period"));
						} catch (error) {
							return jsonResponse(
								{
									ok: false,
									error: digestArchiveRequestErrorMessageOrRethrow(error),
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
