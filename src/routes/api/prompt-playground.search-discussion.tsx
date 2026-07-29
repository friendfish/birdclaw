import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createEffectNdjsonResponse } from "#/lib/ndjson-stream";
import type { PlaygroundStreamEvent } from "#/lib/prompt-playground";
import {
	searchDiscussionPlaygroundRequestSchema,
	searchDiscussionPlaygroundStreamEventSchema,
} from "#/lib/prompt-playground-contracts";
import {
	streamSearchDiscussionPlaygroundEffect,
	type SearchDiscussionPlaygroundResult,
} from "#/lib/search-discussion";

export const Route = createFileRoute(
	"/api/prompt-playground/search-discussion",
)({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const body = yield* requestJsonEffect(request, null);
						const parsed =
							searchDiscussionPlaygroundRequestSchema.safeParse(body);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid Discuss playground request" },
								{ status: 400 },
							);
						}
						return createEffectNdjsonResponse<
							PlaygroundStreamEvent<SearchDiscussionPlaygroundResult>
						>({
							request,
							schema: searchDiscussionPlaygroundStreamEventSchema,
							run: ({ signal, emit }) =>
								streamSearchDiscussionPlaygroundEffect(
									{ ...parsed.data, signal },
									{ onEvent: emit },
								),
							errorEvent: (error) => ({
								type: "error",
								error:
									error instanceof Error
										? error.message
										: "Discuss playground failed",
							}),
						});
					}),
				),
		},
	},
});
