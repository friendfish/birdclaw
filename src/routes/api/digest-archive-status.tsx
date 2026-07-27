import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { peekDigestArchiveRunningPeriodsEffect } from "#/lib/digest-archive-job";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

export const Route = createFileRoute("/api/digest-archive-status")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const runningPeriods =
							yield* peekDigestArchiveRunningPeriodsEffect();
						return jsonResponse({ ok: true, runningPeriods });
					}),
				),
		},
	},
});
