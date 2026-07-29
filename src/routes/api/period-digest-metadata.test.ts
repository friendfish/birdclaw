// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

vi.mock("#/lib/config", () => ({
	getBirdclawConfig: () => ({}),
}));

const resolveEffectivePromptMock = vi.hoisted(() => vi.fn());
vi.mock("#/lib/prompt-templates", () => ({
	resolveEffectivePrompt: () => resolveEffectivePromptMock(),
}));

const readSyncCacheMock = vi.fn();
vi.mock("#/lib/sync-cache", () => ({
	readSyncCache: (...args: unknown[]) => readSyncCacheMock(...args),
}));

const isFreshDigestCacheMock = vi.fn();
vi.mock("#/lib/period-digest", () => ({
	normalizeDigestLanguage: (value: string | undefined) => value,
	latestDigestCacheKey: (
		options: Record<string, unknown>,
		promptHash: string,
	) => `period-digest-latest:test:${promptHash}:${JSON.stringify(options)}`,
	periodDigestGenerationKey: (options: Record<string, unknown>) =>
		`period-digest-generation:test:${JSON.stringify(options)}`,
	isFreshDigestCache: (...args: unknown[]) => isFreshDigestCacheMock(...args),
}));

import { activePeriodDigestsRegistry } from "#/lib/period-digest-active-registry";
import { Route } from "./period-digest-metadata";

const GET = getRouteHandler(Route, "GET");

function requestFor(params: Record<string, string>) {
	const url = new URL("http://localhost/api/period-digest-metadata");
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return new Request(url);
}

const baseParams = {
	period: "today",
	includeDms: "false",
	contentSource: "all",
	maxTweets: "5000",
	maxLinks: "20",
	liveSync: "false",
};

describe("api period-digest-metadata route", () => {
	beforeEach(() => {
		resolveEffectivePromptMock.mockReset();
		resolveEffectivePromptMock.mockReturnValue({ promptHash: "prompt_hash" });
	});

	afterEach(() => {
		activePeriodDigestsRegistry().clear();
		readSyncCacheMock.mockReset();
		isFreshDigestCacheMock.mockReset();
	});

	it("reports isGenerating and the active status label while a matching run is in progress", async () => {
		const registry = activePeriodDigestsRegistry();
		const key = `period-digest-generation:test:${JSON.stringify({
			period: "today",
			since: undefined,
			until: undefined,
			account: undefined,
			includeDms: false,
			contentSource: "all",
			refresh: false,
			model: undefined,
			language: undefined,
			maxTweets: 5000,
			maxLinks: 20,
			liveSync: false,
			liveSyncMode: "xurl",
			liveTimelineLimit: undefined,
			liveTimelineMaxPages: undefined,
		})}`;
		registry.set(key, { label: "Streaming AI summary", detail: "42%" });
		readSyncCacheMock.mockReturnValue(null);

		const response = await GET({ request: requestFor(baseParams) });

		expect(await response.json()).toEqual({
			ok: true,
			isGenerating: true,
			activeStatus: { label: "Streaming AI summary", detail: "42%" },
			result: null,
		});
	});

	it("returns the fresh cached result and isGenerating:false once nothing is running", async () => {
		readSyncCacheMock.mockReturnValue({
			value: {
				context: { window: { label: "Today" }, tweets: [] },
				digest: { actionItems: [] },
				markdown: "# Today",
				model: "gpt-5.5",
				reasoningEffort: "medium",
				serviceTier: "priority",
				parseStatus: "structured",
				updatedAt: "2026-07-27T08:00:00.000Z",
			},
			updatedAt: "2026-07-27T08:00:00.000Z",
		});
		isFreshDigestCacheMock.mockReturnValue(true);

		const response = await GET({ request: requestFor(baseParams) });

		expect(await response.json()).toEqual({
			ok: true,
			isGenerating: false,
			activeStatus: null,
			result: {
				context: { window: { label: "Today" }, tweets: [] },
				digest: { actionItems: [] },
				markdown: "# Today",
				model: "gpt-5.5",
				reasoningEffort: "medium",
				serviceTier: "priority",
				parseStatus: "structured",
				cached: true,
				updatedAt: "2026-07-27T08:00:00.000Z",
			},
		});
	});

	it("omits a stale cached result rather than passing it off as current", async () => {
		readSyncCacheMock.mockReturnValue({
			value: {
				context: { window: { label: "Today" }, tweets: [] },
				digest: { actionItems: [] },
				markdown: "# Stale",
				model: "gpt-5.5",
				reasoningEffort: "medium",
				serviceTier: "priority",
				parseStatus: "structured",
				updatedAt: "2020-01-01T00:00:00.000Z",
			},
			updatedAt: "2020-01-01T00:00:00.000Z",
		});
		isFreshDigestCacheMock.mockReturnValue(false);

		const response = await GET({ request: requestFor(baseParams) });

		expect(await response.json()).toEqual({
			ok: true,
			isGenerating: false,
			activeStatus: null,
			result: null,
		});
	});

	it("returns no result when nothing has ever been cached", async () => {
		readSyncCacheMock.mockReturnValue(null);

		const response = await GET({ request: requestFor(baseParams) });

		expect(await response.json()).toEqual({
			ok: true,
			isGenerating: false,
			activeStatus: null,
			result: null,
		});
	});

	it("does not return a cache row stored under an older prompt hash", async () => {
		resolveEffectivePromptMock.mockReturnValue({
			promptHash: "new_prompt_hash",
		});
		readSyncCacheMock.mockImplementation((key: string) =>
			key.includes("old_prompt_hash")
				? { value: { markdown: "# Old" }, updatedAt: "2026-07-27" }
				: null,
		);

		const response = await GET({ request: requestFor(baseParams) });

		expect(readSyncCacheMock).toHaveBeenCalledWith(
			expect.stringContaining("new_prompt_hash"),
		);
		expect(await response.json()).toMatchObject({ result: null });
	});
});
