import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { getBirdclawConfig, writeBirdclawConfig } from "#/lib/config";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

const configRequestSchema = z.object({
	provider: z.string().optional(),
	baseUrl: z.string().optional(),
	apiKey: z.string().optional(),
	model: z.string().optional(),
	ai: z
		.object({
			provider: z.string().optional(),
			baseUrl: z.string().optional(),
			apiKey: z.string().optional(),
			model: z.string().optional(),
		})
		.optional(),
	language: z
		.object({
			aiLanguage: z.string().optional(),
			uiLanguage: z.string().optional(),
		})
		.optional(),
});

export const Route = createFileRoute("/api/config")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						yield* Effect.void;
						const config = getBirdclawConfig();
						return jsonResponse({
							ok: true,
							ai: config.ai || {},
							language: config.language || {
								aiLanguage: "zh-CN",
								uiLanguage: "zh-CN",
							},
						});
					}),
				),
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const body = yield* Effect.tryPromise({
							try: () => request.json(),
							catch: (error) => error,
						});

						const parsed = configRequestSchema.parse(body);
						const config = getBirdclawConfig();

						const nextConfig = {
							...config,
							ai: {
								...config.ai,
								...parsed.ai,
								...(parsed.provider !== undefined
									? { provider: parsed.provider }
									: {}),
								...(parsed.baseUrl !== undefined
									? { baseUrl: parsed.baseUrl }
									: {}),
								...(parsed.apiKey !== undefined
									? { apiKey: parsed.apiKey }
									: {}),
								...(parsed.model !== undefined ? { model: parsed.model } : {}),
							},
							language: {
								...config.language,
								...parsed.language,
							},
						};

						writeBirdclawConfig(nextConfig);

						return jsonResponse({
							ok: true,
							ai: nextConfig.ai,
							language: nextConfig.language,
						});
					}),
				),
		},
	},
});
