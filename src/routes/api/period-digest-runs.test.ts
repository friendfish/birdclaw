// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const requestPeriodDigestRunMock = vi.fn();
vi.mock("#/lib/period-digest-orchestrator", () => ({
	requestPeriodDigestRun: (...args: unknown[]) =>
		requestPeriodDigestRunMock(...args),
}));

import { Route } from "./period-digest-runs";

const POST = getRouteHandler(Route, "POST");

describe("api period-digest-runs route", () => {
	beforeEach(() => {
		requestPeriodDigestRunMock.mockReset();
		requestPeriodDigestRunMock.mockResolvedValue({
			runId: "run-current",
			joined: false,
			completion: new Promise(() => undefined),
		});
	});

	it("starts one server-owned manual batch and returns immediately", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/period-digest-runs", {
				method: "POST",
				body: JSON.stringify({
					period: "24h",
					requestedSource: "for_you",
					liveSync: false,
				}),
			}),
		});

		expect(requestPeriodDigestRunMock).toHaveBeenCalledWith({
			period: "24h",
			trigger: "manual",
			origin: "page",
			requestedSource: "for_you",
			liveSync: false,
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			ok: true,
			runId: "run-current",
			joined: false,
		});
	});

	it("rejects archived periods before requesting a run", async () => {
		await expect(
			POST({
				request: new Request("http://localhost/api/period-digest-runs", {
					method: "POST",
					body: JSON.stringify({ period: "week", requestedSource: "all" }),
				}),
			}),
		).rejects.toThrow(/period/u);
		expect(requestPeriodDigestRunMock).not.toHaveBeenCalled();
	});

	it("keeps orchestrator rejection in the typed route failure channel", async () => {
		requestPeriodDigestRunMock.mockRejectedValue(new Error("run unavailable"));
		await expect(
			POST({
				request: new Request("http://localhost/api/period-digest-runs", {
					method: "POST",
					body: JSON.stringify({ period: "today", requestedSource: "all" }),
				}),
			}),
		).rejects.toThrow("run unavailable");
	});
});
