import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resolveTodayMaxWidthPx } from "#/lib/config";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

export const Route = createFileRoute("/api/ui-config")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						yield* Effect.void;
						return jsonResponse({
							ok: true,
							ui: { todayMaxWidthPx: resolveTodayMaxWidthPx() },
						});
					}),
				),
		},
	},
});
