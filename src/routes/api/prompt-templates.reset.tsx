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
} from "#/lib/prompt-templates";

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
						const definition = promptTemplateDefinition(parsed.data.feature);
						return jsonResponse({
							ok: true,
							template: resetPromptTemplate(parsed.data.feature),
							definition: {
								label: definition.label,
								description: definition.description,
								protocol: definition.protocol,
							},
						});
					}),
				),
		},
	},
});
