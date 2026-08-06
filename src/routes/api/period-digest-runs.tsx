import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { requestPeriodDigestRun } from "#/lib/period-digest-orchestrator";

const periodDigestRunRequestSchema = z.object({
	period: z.enum(["today", "24h"]),
	requestedSource: z.enum(["all", "following", "for_you"]),
	account: z.string().min(1).optional(),
	liveSync: z.boolean().optional().default(true),
});

export const Route = createFileRoute("/api/period-digest-runs")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const body = yield* requestJsonEffect(request);
						const parsed = periodDigestRunRequestSchema.parse(body);
						const run = yield* Effect.tryPromise({
							try: () =>
								requestPeriodDigestRun({
									period: parsed.period,
									trigger: "manual",
									origin: "page",
									requestedSource: parsed.requestedSource,
									...(parsed.account ? { account: parsed.account } : {}),
									liveSync: parsed.liveSync,
								}),
							catch: (error) => error,
						});

						return jsonResponse(
							{ ok: true, runId: run.runId, joined: run.joined },
							{ status: 202 },
						);
					}),
				),
		},
	},
});
