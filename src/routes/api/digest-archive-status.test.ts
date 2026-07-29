// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const peekDigestArchiveRunningRunsEffectMock = vi.fn();

vi.mock("#/lib/digest-archive-job", () => ({
	peekDigestArchiveRunningRunsEffect: () =>
		Effect.promise(() => peekDigestArchiveRunningRunsEffectMock()),
}));

import { Route } from "./digest-archive-status";

const GET = getRouteHandler(Route, "GET");

describe("api digest-archive-status route", () => {
	it("reports which periods are currently archiving", async () => {
		peekDigestArchiveRunningRunsEffectMock.mockResolvedValue([
			{ period: "today", runDate: "2026-07-29" },
			{ period: "24h", runDate: "2026-07-29" },
		]);

		const response = await GET({
			request: new Request("http://localhost/api/digest-archive-status"),
		});

		expect(await response.json()).toEqual({
			ok: true,
			runningPeriods: ["today", "24h"],
			activeRuns: [
				{ period: "today", runDate: "2026-07-29" },
				{ period: "24h", runDate: "2026-07-29" },
			],
		});
	});

	it("reports an empty list when nothing is running", async () => {
		peekDigestArchiveRunningRunsEffectMock.mockResolvedValue([]);

		const response = await GET({
			request: new Request("http://localhost/api/digest-archive-status"),
		});

		expect(await response.json()).toEqual({
			ok: true,
			runningPeriods: [],
			activeRuns: [],
		});
	});
});
