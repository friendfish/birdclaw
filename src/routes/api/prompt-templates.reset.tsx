import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { promptTemplateResetRequestSchema } from "#/lib/prompt-playground-contracts";
import {
	promptTemplateDefinition,
	resetPromptTemplate,
	type PromptFeature,
} from "#/lib/prompt-templates";

function responseFor(feature: PromptFeature) {
	const definition = promptTemplateDefinition(feature);
	return {
		ok: true as const,
		template: resetPromptTemplate(feature),
		definition: {
			label: definition.label,
			description: definition.description,
			protocol: definition.protocol,
		},
	};
}

export const Route = createFileRoute("/api/prompt-templates/reset")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const body = yield* requestJsonEffect(request, null);
						const parsed = promptTemplateResetRequestSchema.safeParse(body);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid reset request" },
								{ status: 400 },
							);
						}
						return yield* Effect.try({
							try: () => jsonResponse(responseFor(parsed.data.feature)),
							catch: (error) =>
								jsonResponse(
									{
										ok: false,
										message:
											error instanceof Error
												? error.message
												: "Unable to reset prompt template",
									},
									{ status: 400 },
								),
						}).pipe(Effect.merge);
					}),
				),
		},
	},
});
