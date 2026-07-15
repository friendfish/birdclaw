import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

const fetchModelsRequestSchema = z.object({
	baseUrl: z.string(),
	apiKey: z.string(),
});

export const Route = createFileRoute("/api/config-models")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const body = yield* Effect.tryPromise({
							try: () => request.json(),
							catch: (error) => error,
						});

						const { baseUrl, apiKey } = fetchModelsRequestSchema.parse(body);
						const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, "");
						const url = `${cleanBaseUrl}/models`;

						const response = yield* Effect.tryPromise({
							try: () =>
								fetch(url, {
									method: "GET",
									headers: {
										Authorization: `Bearer ${apiKey.trim()}`,
										"Content-Type": "application/json",
									},
								}),
							catch: (error) =>
								new Error(
									`Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`,
								),
						});

						if (!response.ok) {
							return jsonResponse({
								ok: false,
								error: `Provider returned status ${String(response.status)}`,
							});
						}

						const data = (yield* Effect.tryPromise({
							try: () => response.json(),
							catch: (error) => error,
						})) as any;

						const models: string[] = [];
						if (data && Array.isArray(data.data)) {
							for (const model of data.data) {
								if (model && typeof model.id === "string") {
									models.push(model.id);
								}
							}
						}

						return jsonResponse({
							ok: true,
							models: models.sort(),
						});
					}),
				),
		},
	},
});
