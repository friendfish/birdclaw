import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import {
	getBirdclawConfig,
	MAX_TODAY_MAX_WIDTH_PX,
	MIN_TODAY_MAX_WIDTH_PX,
	resolveTodayMaxWidthPx,
	writeBirdclawConfig,
} from "#/lib/config";
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
	ui: z
		.object({
			todayMaxWidthPx: z
				.number()
				.int()
				.min(MIN_TODAY_MAX_WIDTH_PX)
				.max(MAX_TODAY_MAX_WIDTH_PX),
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
							ui: { todayMaxWidthPx: resolveTodayMaxWidthPx() },
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

						const result = configRequestSchema.safeParse(body);
						if (!result.success) {
							return jsonResponse(
								{ ok: false, message: "Invalid config payload" },
								{ status: 400 },
							);
						}
						const parsed = result.data;
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
							...(parsed.ui ? { ui: { ...config.ui, ...parsed.ui } } : {}),
						};

						writeBirdclawConfig(nextConfig);

						return jsonResponse({
							ok: true,
							ai: nextConfig.ai,
							language: nextConfig.language,
							ui: { todayMaxWidthPx: resolveTodayMaxWidthPx() },
						});
					}),
				),
		},
	},
});
