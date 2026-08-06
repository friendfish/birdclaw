// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const triggerDuePeriodDigestFreshnessMock = vi.fn();
vi.mock("#/lib/period-digest-freshness", () => ({
	triggerDuePeriodDigestFreshness: (...args: unknown[]) =>
		triggerDuePeriodDigestFreshnessMock(...args),
}));
vi.mock("#/lib/period-digest", () => ({
	normalizePeriod: (value: string | undefined) => value ?? "today",
}));

import { Route } from "./period-digest-freshness";

const POST = getRouteHandler(Route, "POST");

describe("api period-digest-freshness route", () => {
	beforeEach(() => {
		triggerDuePeriodDigestFreshnessMock.mockReset();
		triggerDuePeriodDigestFreshnessMock.mockResolvedValue({
			triggered: true,
			runId: "fresh-run",
			joined: false,
		});
	});

	it("uses a server-owned page origin and returns immediately", async () => {
		const response = await POST({
			request: new Request(
				"http://localhost/api/period-digest-freshness?period=24h",
				{ method: "POST" },
			),
		});
		expect(triggerDuePeriodDigestFreshnessMock).toHaveBeenCalledWith({
			period: "24h",
			origin: "page",
		});
		expect(await response.json()).toEqual({
			ok: true,
			triggered: true,
			runId: "fresh-run",
			joined: false,
		});
	});

	it("rejects archived periods", async () => {
		const response = await POST({
			request: new Request(
				"http://localhost/api/period-digest-freshness?period=week",
				{ method: "POST" },
			),
		});
		expect(response.status).toBe(400);
		expect(triggerDuePeriodDigestFreshnessMock).not.toHaveBeenCalled();
	});
});
