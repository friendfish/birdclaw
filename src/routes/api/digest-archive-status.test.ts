// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getDigestArchiveStatusEffectMock = vi.fn();

vi.mock("#/lib/digest-archive-job", () => ({
	getDigestArchiveStatusEffect: () =>
		Effect.promise(() => getDigestArchiveStatusEffectMock()),
}));

import { Route } from "./digest-archive-status";

const GET = getRouteHandler(Route, "GET");

describe("api digest-archive-status route", () => {
	it("reports which periods are currently archiving", async () => {
		getDigestArchiveStatusEffectMock.mockResolvedValue({
			activeRuns: [
				{
					period: "today",
					runDate: "2026-07-29",
					totalSources: 2,
					phase: "generating",
					currentSource: "following",
					startedAt: "2026-07-29T00:00:00.000Z",
					lastHeartbeatAt: "2026-07-29T00:01:00.000Z",
					sources: {
						all: {
							state: "completed",
							attempts: 1,
							generatedAt: "2026-07-29T00:00:40.000Z",
						},
						following: { state: "running", attempts: 1 },
					},
				},
			],
			lastRuns: [
				{
					period: "yesterday",
					runDate: "2026-07-28",
					status: "failed",
					finishedAt: "2026-07-29T00:02:00.000Z",
					sources: {
						for_you: {
							state: "failed",
							attempts: 2,
							error: "attempt timed out",
						},
					},
				},
			],
		});

		const response = await GET({
			request: new Request("http://localhost/api/digest-archive-status"),
		});

		expect(await response.json()).toEqual({
			ok: true,
			runningPeriods: ["today"],
			activeRuns: [
				{
					period: "today",
					runDate: "2026-07-29",
					totalSources: 2,
					phase: "generating",
					currentSource: "following",
					startedAt: "2026-07-29T00:00:00.000Z",
					lastHeartbeatAt: "2026-07-29T00:01:00.000Z",
					sources: {
						all: {
							state: "completed",
							attempts: 1,
							generatedAt: "2026-07-29T00:00:40.000Z",
						},
						following: { state: "running", attempts: 1 },
					},
				},
			],
			lastRuns: [
				{
					period: "yesterday",
					runDate: "2026-07-28",
					status: "failed",
					finishedAt: "2026-07-29T00:02:00.000Z",
					sources: {
						for_you: {
							state: "failed",
							attempts: 2,
							error: "attempt timed out",
						},
					},
				},
			],
		});
	});

	it("reports an empty list when nothing is running", async () => {
		getDigestArchiveStatusEffectMock.mockResolvedValue({
			activeRuns: [],
			lastRuns: [],
		});

		const response = await GET({
			request: new Request("http://localhost/api/digest-archive-status"),
		});

		expect(await response.json()).toEqual({
			ok: true,
			runningPeriods: [],
			activeRuns: [],
			lastRuns: [],
		});
	});
});
