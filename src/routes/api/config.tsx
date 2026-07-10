import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { getBirdclawConfig, writeBirdclawConfig } from "#/lib/config";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

const aiConfigSchema = z.object({
	provider: z.string().optional(),
	baseUrl: z.string().optional(),
	apiKey: z.string().optional(),
	model: z.string().optional(),
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

						const parsed = aiConfigSchema.parse(body);
						const config = getBirdclawConfig();

						const nextConfig = {
							...config,
							ai: {
								...config.ai,
								...parsed,
							},
						};

						writeBirdclawConfig(nextConfig);

						return jsonResponse({
							ok: true,
							ai: nextConfig.ai,
						});
					}),
				),
		},
	},
});
