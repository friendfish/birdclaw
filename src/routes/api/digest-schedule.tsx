import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { getBirdCredentialsPath } from "#/lib/bird-credentials";
import {
	getBirdclawConfig,
	resolveDigestArchiveDir,
	resolveDigestFreshnessSeconds,
	writeBirdclawConfig,
} from "#/lib/config";
import {
	installAllDigestArchiveLaunchAgentsEffect,
	resolveDigestScheduleTime,
} from "#/lib/digest-archive-job";
import {
	readPeriodDigestFreshnessState,
	reconcileAllPeriodDigestFreshness,
} from "#/lib/period-digest-freshness";
import { readPeriodDigestRunState } from "#/lib/period-digest-orchestrator";
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
	freshnessHours: z.number().int().min(1).max(24),
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

async function schedulerStatus() {
	const [todayFreshness, hour24Freshness, todayRun, hour24Run] =
		await Promise.all([
			readPeriodDigestFreshnessState("today"),
			readPeriodDigestFreshnessState("24h"),
			readPeriodDigestRunState("today"),
			readPeriodDigestRunState("24h"),
		]);
	return {
		freshness: {
			today: todayFreshness ?? null,
			"24h": hour24Freshness ?? null,
		},
		runs: {
			today: todayRun ?? null,
			"24h": hour24Run ?? null,
		},
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

						const status = yield* Effect.promise(schedulerStatus);
						return jsonResponse({
							ok: true,
							archiveDir: resolveDigestArchiveDir(),
							freshnessHours: resolveDigestFreshnessSeconds() / 3600,
							schedule: currentSchedule(),
							...status,
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
								freshnessSeconds: parsed.freshnessHours * 3600,
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
						const freshnessResults = yield* Effect.promise(() =>
							reconcileAllPeriodDigestFreshness(),
						);
						const fixedHealthy = Object.values(installResults).every(
							(result) => result.ok,
						);
						const freshnessHealthy = Object.values(freshnessResults).every(
							(result) => result.state.status !== "error",
						);
						const status = yield* Effect.promise(schedulerStatus);

						return jsonResponse({
							ok: fixedHealthy && freshnessHealthy,
							archiveDir: resolveDigestArchiveDir(),
							freshnessHours: resolveDigestFreshnessSeconds() / 3600,
							schedule: currentSchedule(),
							installResults,
							freshnessResults,
							...status,
						});
					}),
				),
		},
	},
});
