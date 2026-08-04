import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { getBirdCredentialsPath } from "#/lib/bird-credentials";
import {
	getBirdclawConfig,
	resolveDigestArchiveDir,
	writeBirdclawConfig,
} from "#/lib/config";
import {
	installAllDigestArchiveLaunchAgentsEffect,
	resolveDigestScheduleTime,
} from "#/lib/digest-archive-job";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";

const scheduleTimeSchema = z.object({
	hour: z.number().int().min(0).max(23),
	minute: z.number().int().min(0).max(59),
});

const digestScheduleRequestSchema = z.object({
	archiveDir: z.string().optional(),
	schedule: z.object({
		today: scheduleTimeSchema,
		"24h": scheduleTimeSchema,
		yesterday: scheduleTimeSchema,
		// weekday is intentionally not accepted from this route — Week always
		// runs on Monday; only the time of day is user-configurable.
		week: scheduleTimeSchema,
	}),
});

function currentSchedule() {
	return {
		today: resolveDigestScheduleTime("today"),
		"24h": resolveDigestScheduleTime("24h"),
		yesterday: resolveDigestScheduleTime("yesterday"),
		week: resolveDigestScheduleTime("week"),
	};
}

export const Route = createFileRoute("/api/digest-schedule")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						yield* Effect.void;
						return jsonResponse({
							ok: true,
							archiveDir: resolveDigestArchiveDir(),
							schedule: currentSchedule(),
						});
					}),
				),
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const body = yield* requestJsonEffect(request);
						const parsed = digestScheduleRequestSchema.parse(body);
						const config = getBirdclawConfig();
						const nextConfig = {
							...config,
							digest: {
								...config.digest,
								...(parsed.archiveDir !== undefined
									? { archiveDir: parsed.archiveDir }
									: {}),
								schedule: {
									today: parsed.schedule.today,
									"24h": parsed.schedule["24h"],
									yesterday: parsed.schedule.yesterday,
									week: { ...parsed.schedule.week, weekday: 1 },
								},
							},
						};
						writeBirdclawConfig(nextConfig);

						const installResults =
							yield* installAllDigestArchiveLaunchAgentsEffect({
								today: {
									...parsed.schedule.today,
									birdCredentialsPath: getBirdCredentialsPath(),
								},
								"24h": {
									...parsed.schedule["24h"],
									birdCredentialsPath: getBirdCredentialsPath(),
								},
								yesterday: {
									...parsed.schedule.yesterday,
									birdCredentialsPath: getBirdCredentialsPath(),
								},
								week: {
									...parsed.schedule.week,
									weekday: 1,
									birdCredentialsPath: getBirdCredentialsPath(),
								},
							});

						return jsonResponse({
							ok: true,
							archiveDir: resolveDigestArchiveDir(),
							schedule: currentSchedule(),
							installResults,
						});
					}),
				),
		},
	},
});
