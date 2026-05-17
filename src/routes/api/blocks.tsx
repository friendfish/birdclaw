import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { getBlocksResponse } from "#/lib/blocks";
import {
	jsonResponse,
	parseBoundedInteger,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

export const Route = createFileRoute("/api/blocks")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						return jsonResponse(
							getBlocksResponse({
								accountId: url.searchParams.get("account") ?? undefined,
								search: url.searchParams.get("search") ?? undefined,
								limit: parseBoundedInteger(url.searchParams.get("limit"), {
									defaultValue: 12,
									max: 50,
								}),
							}),
						);
					}),
				),
		},
	},
});
