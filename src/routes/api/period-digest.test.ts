// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

vi.mock("#/lib/live-transport-policy", () => ({
	resolveLiveReadMode: () => "bird",
}));

const maybeAutoUpdateBackupMock = vi.fn();
const streamPeriodDigestMock = vi.fn();
const requestPeriodDigestRunMock = vi.fn();

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(maybeAutoUpdateBackupMock())),
}));
vi.mock("#/lib/period-digest", () => ({
	normalizeDigestLanguage: (value: string | undefined) => {
		if (!value) return undefined;
		if (value === "ZH-cn") return "zh-CN";
		throw new Error(
			"Digest language must be a valid Unicode locale identifier",
		);
	},
	normalizePeriod: (value: string | undefined) => {
		if (value === "24h") return "24h";
		if (value === "yesterday") return "yesterday";
		if (value === "week") return "week";
		return "today";
	},
	periodDigestGenerationKey: (options: Record<string, unknown>) =>
		`period-digest-generation:test:${JSON.stringify(options)}`,
	streamPeriodDigestEffect: (...args: unknown[]) =>
		Effect.promise(() => streamPeriodDigestMock(...args)),
}));
vi.mock("#/lib/period-digest-orchestrator", () => ({
	requestPeriodDigestRun: (...args: unknown[]) =>
		requestPeriodDigestRunMock(...args),
}));

import { Route } from "./period-digest";

const GET = getRouteHandler(Route, "GET");

describe("api period digest route", () => {
	beforeEach(() => {
		maybeAutoUpdateBackupMock.mockReset();
		streamPeriodDigestMock.mockReset();
		requestPeriodDigestRunMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
		requestPeriodDigestRunMock.mockResolvedValue({
			runId: "run-current",
			joined: false,
			completion: new Promise(() => undefined),
		});
		streamPeriodDigestMock.mockImplementation(
			async (
				_options: unknown,
				handlers?: { onEvent?: (event: unknown) => void },
			) => {
				handlers?.onEvent?.({ type: "delta", delta: "# Week\n" });
				handlers?.onEvent?.({
					type: "done",
					result: {
						markdown: "# Week",
						model: "gpt-5.5",
						cached: false,
						serviceTier: "priority",
						parseStatus: "structured",
						context: {
							window: { label: "Week", since: "s", until: "u" },
							includeDms: false,
							counts: { home: 0, mentions: 0, links: 0, dms: 0 },
							tweets: [],
							dms: [],
							links: [],
							hash: "week",
						},
						digest: { actionItems: [] },
					},
				});
			},
		);
	});

	it("starts a server-owned manual Today batch and returns without awaiting it", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/period-digest?period=today&contentSource=for_you&includeDms=true&origin=launchd",
			),
		});
		const body = await response.text();

		expect(body).toContain('"type":"status"');
		expect(body).toContain("run-current");
		expect(requestPeriodDigestRunMock).toHaveBeenCalledWith({
			period: "today",
			trigger: "manual",
			origin: "page",
			requestedSource: "for_you",
			liveSync: true,
		});
		expect(streamPeriodDigestMock).not.toHaveBeenCalled();
	});

	it("reports a join as normal progress instead of a lock error", async () => {
		requestPeriodDigestRunMock.mockResolvedValue({
			runId: "run-scheduled",
			joined: true,
			completion: new Promise(() => undefined),
		});

		const body = await (
			await GET({
				request: new Request(
					"http://localhost/api/period-digest?period=24h&contentSource=all",
				),
			})
		).text();

		expect(body).toContain("Joined existing digest run");
		expect(body).not.toContain('"type":"error"');
	});

	it("preserves the direct streaming endpoint for archived periods", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/period-digest?period=week&refresh=1&language=ZH-cn",
			),
		});

		expect(await response.text()).toContain('"type":"done"');
		expect(streamPeriodDigestMock).toHaveBeenCalledWith(
			expect.objectContaining({
				period: "week",
				refresh: true,
				language: "zh-CN",
				signal: undefined,
			}),
			expect.any(Object),
		);
		expect(requestPeriodDigestRunMock).not.toHaveBeenCalled();
	});

	it("rejects invalid language tags before starting any run", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/period-digest?period=today&language=not_a_locale",
			),
		});

		expect(response.status).toBe(400);
		expect(requestPeriodDigestRunMock).not.toHaveBeenCalled();
		expect(streamPeriodDigestMock).not.toHaveBeenCalled();
	});
});
