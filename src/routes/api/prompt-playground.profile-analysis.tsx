import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	profileAnalysisPlaygroundRequestSchema,
	profileAnalysisPlaygroundResponseSchema,
} from "#/lib/prompt-playground-contracts";
import { runProfileAnalysisPlaygroundEffect } from "#/lib/profile-analysis";

export const Route = createFileRoute("/api/prompt-playground/profile-analysis")(
	{
		server: {
			handlers: {
				POST: ({ request }) =>
					runRouteEffect(
						Effect.gen(function* () {
							const denied = sensitiveRequestErrorResponse(request);
							if (denied) return denied;
							const body = yield* requestJsonEffect(request, null);
							const parsed =
								profileAnalysisPlaygroundRequestSchema.safeParse(body);
							if (!parsed.success) {
								return jsonResponse(
									{ ok: false, message: "Invalid Analyse playground request" },
									{ status: 400 },
								);
							}
							const result = yield* runProfileAnalysisPlaygroundEffect({
								...parsed.data,
								signal: request.signal,
							});
							return jsonResponse(
								profileAnalysisPlaygroundResponseSchema.parse({
									ok: true,
									result,
								}),
							);
						}),
					),
			},
		},
	},
);
