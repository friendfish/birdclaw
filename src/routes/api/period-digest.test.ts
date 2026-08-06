// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

vi.mock("#/lib/live-transport-policy", () => ({
	resolveLiveReadMode: () => "bird",
}));

const maybeAutoUpdateBackupMock = vi.fn();
const streamPeriodDigestMock = vi.fn();

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

import { Route } from "./period-digest";

const GET = getRouteHandler(Route, "GET");

describe("api period digest route", () => {
	beforeEach(() => {
		maybeAutoUpdateBackupMock.mockReset();
		streamPeriodDigestMock.mockReset();
		maybeAutoUpdateBackupMock.mockResolvedValue({ skipped: true });
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

	it("does not create a Today batch from the read endpoint", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/period-digest?period=today&contentSource=for_you&includeDms=true&origin=launchd",
			),
		});
		const body = await response.text();

		expect(response.status).toBe(405);
		expect(body).toContain('"ok":false');
		expect(body).toContain("POST /api/period-digest-runs");
		expect(streamPeriodDigestMock).not.toHaveBeenCalled();
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
	});

	it("rejects invalid language tags before starting any run", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/period-digest?period=today&language=not_a_locale",
			),
		});

		expect(response.status).toBe(400);
		expect(streamPeriodDigestMock).not.toHaveBeenCalled();
	});
});
