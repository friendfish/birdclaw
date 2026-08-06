import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { normalizePeriod } from "#/lib/period-digest";
import { triggerDuePeriodDigestFreshness } from "#/lib/period-digest-freshness";

export const Route = createFileRoute("/api/period-digest-freshness")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const period = normalizePeriod(
							new URL(request.url).searchParams.get("period") ?? undefined,
						);
						if (period !== "today" && period !== "24h") {
							return jsonResponse(
								{ ok: false, error: "Freshness supports Today and 24h" },
								{ status: 400 },
							);
						}
						const result = yield* Effect.promise(() =>
							triggerDuePeriodDigestFreshness({ period, origin: "page" }),
						);
						return jsonResponse({ ok: true, ...result });
					}),
				),
		},
	},
});
