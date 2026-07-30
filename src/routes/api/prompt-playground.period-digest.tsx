import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { createEffectNdjsonResponse } from "#/lib/ndjson-stream";
import {
	streamPeriodDigestPlaygroundEffect,
	type PeriodDigestPlaygroundResult,
} from "#/lib/period-digest";
import type { PlaygroundStreamEvent } from "#/lib/prompt-playground";
import {
	periodDigestPlaygroundRequestSchema,
	periodDigestPlaygroundStreamEventSchema,
} from "#/lib/prompt-playground-contracts";

export const Route = createFileRoute("/api/prompt-playground/period-digest")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const body = yield* requestJsonEffect(request, null);
						const parsed = periodDigestPlaygroundRequestSchema.safeParse(body);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid Today playground request" },
								{ status: 400 },
							);
						}
						return createEffectNdjsonResponse<
							PlaygroundStreamEvent<PeriodDigestPlaygroundResult>
						>({
							request,
							schema: periodDigestPlaygroundStreamEventSchema,
							run: ({ signal, emit }) =>
								streamPeriodDigestPlaygroundEffect(
									{ ...parsed.data, signal },
									{ onEvent: emit },
								),
							errorEvent: (error) => ({
								type: "error",
								error:
									error instanceof Error
										? error.message
										: "Today playground failed",
							}),
						});
					}),
				),
		},
	},
});
