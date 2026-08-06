import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resolveDigestArchiveDir } from "#/lib/config";
import { listDigestArchiveDatesEffect } from "#/lib/digest-archive-job";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

function parsePeriod(value: string | null): "yesterday" | "week" {
	return value === "week" ? "week" : "yesterday";
}

function currentPeriodError(value: string | null) {
	return value === "today" || value === "24h";
}

export const Route = createFileRoute("/api/digest-archive-dates")({
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
