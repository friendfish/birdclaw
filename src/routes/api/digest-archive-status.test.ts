// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const peekDigestArchiveRunningPeriodsEffectMock = vi.fn();

vi.mock("#/lib/digest-archive-job", () => ({
	peekDigestArchiveRunningPeriodsEffect: () =>
		Effect.promise(() => peekDigestArchiveRunningPeriodsEffectMock()),
}));

import { Route } from "./digest-archive-status";

const GET = getRouteHandler(Route, "GET");

describe("api digest-archive-status route", () => {
	it("reports which periods are currently archiving", async () => {
		peekDigestArchiveRunningPeriodsEffectMock.mockResolvedValue([
			"today",
			"24h",
		]);

		const response = await GET({
			request: new Request("http://localhost/api/digest-archive-status"),
		});

		expect(await response.json()).toEqual({
			ok: true,
			runningPeriods: ["today", "24h"],
		});
	});

	it("reports an empty list when nothing is running", async () => {
		peekDigestArchiveRunningPeriodsEffectMock.mockResolvedValue([]);

		const response = await GET({
			request: new Request("http://localhost/api/digest-archive-status"),
		});

		expect(await response.json()).toEqual({ ok: true, runningPeriods: [] });
	});
});
