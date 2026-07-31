import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	promptFeatureSchema,
	promptTemplateSaveRequestSchema,
} from "#/lib/prompt-playground-contracts";
import {
	promptTemplateDefinition,
	readPromptTemplate,
	writePromptTemplate,
	type PromptFeature,
} from "#/lib/prompt-templates";

function responseFor(feature: PromptFeature) {
	const definition = promptTemplateDefinition(feature);
	return {
		ok: true as const,
		template: readPromptTemplate(feature),
		definition: {
			label: definition.label,
			description: definition.description,
			protocol: definition.protocol,
		},
	};
}

export const Route = createFileRoute("/api/prompt-templates")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const feature = promptFeatureSchema.safeParse(
							new URL(request.url).searchParams.get("feature"),
						);
						return feature.success
							? jsonResponse(responseFor(feature.data))
							: jsonResponse(
									{ ok: false, message: "Unknown prompt feature" },
									{ status: 400 },
								);
					}),
				),
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;
						const body = yield* requestJsonEffect(request, null);
						const parsed = promptTemplateSaveRequestSchema.safeParse(body);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid prompt template request" },
								{ status: 400 },
							);
						}
						return yield* Effect.try({
							try: () => {
								writePromptTemplate(parsed.data.feature, parsed.data);
								return jsonResponse(responseFor(parsed.data.feature));
							},
							catch: (error) =>
								jsonResponse(
									{
										ok: false,
										message:
											error instanceof Error
												? error.message
												: "Unable to save prompt template",
									},
									{ status: 400 },
								),
						}).pipe(Effect.merge);
					}),
				),
		},
	},
});
