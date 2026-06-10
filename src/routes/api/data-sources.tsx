import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { getLiveDataSourcesEffect } from "#/lib/data-sources";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

export const Route = createFileRoute("/api/data-sources")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						return jsonResponse(yield* getLiveDataSourcesEffect());
					}),
				),
		},
	},
});
