// @vitest-environment node
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const playgroundMocks = vi.hoisted(() => ({
	period: vi.fn(),
	profile: vi.fn(),
	search: vi.fn(),
}));

vi.mock("#/lib/period-digest", () => ({
	streamPeriodDigestPlaygroundEffect: playgroundMocks.period,
}));

vi.mock("#/lib/profile-analysis", () => ({
	runProfileAnalysisPlaygroundEffect: playgroundMocks.profile,
}));

vi.mock("#/lib/search-discussion", () => ({
	streamSearchDiscussionPlaygroundEffect: playgroundMocks.search,
}));

import { Route as PeriodRoute } from "./prompt-playground.period-digest";
import { Route as ProfileRoute } from "./prompt-playground.profile-analysis";
import { Route as SearchRoute } from "./prompt-playground.search-discussion";

const PERIOD = getRouteHandler(PeriodRoute, "POST");
const PROFILE = getRouteHandler(ProfileRoute, "POST");
const SEARCH = getRouteHandler(SearchRoute, "POST");

function post(pathname: string, body: unknown, headers?: HeadersInit) {
	return new Request(`http://localhost${pathname}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function periodResult() {
	return {
		markdown: "# Today",
		digest: {
			title: "Today",
			summary: "Summary",
			keyTopics: [],
			notableLinks: [],
			people: [],
			actionItems: [],
			sourceTweetIds: [],
		},
		parseStatus: "structured" as const,
		generatedAt: "2026-07-30T12:00:00.000Z",
	};
}

function profileResult() {
	return {
		markdown: "# Analyse",
		analysis: {
			title: "Alice",
			summary: "Summary",
			voice: "Direct",
			themes: [],
			conversationStyle: "Concise",
			notableSignals: [],
			risks: [],
			followUps: [],
			sourceTweetIds: [],
			sourceHandles: ["alice"],
		},
		parseStatus: "structured" as const,
		generatedAt: "2026-07-30T12:00:00.000Z",
	};
}

function searchResult() {
	return {
		markdown: "# Discuss",
		discussion: {
			title: "Discuss",
			summary: "Summary",
			themes: [],
			tensions: [],
			followUps: [],
			sourceTweetIds: [],
			sourceDmConversationIds: [],
		},
		parseStatus: "structured" as const,
		generatedAt: "2026-07-30T12:00:00.000Z",
	};
}

const periodRequest = {
	period: "today",
	contentSource: "all",
	system: "System",
	requirements: "Requirements",
};
const profileRequest = {
	handle: "alice",
	system: "System",
	requirements: "Requirements",
};
const searchRequest = {
	query: "local-first",
	system: "System",
	requirements: "Requirements",
};

afterEach(() => {
	delete process.env.BIRDCLAW_WEB_TOKEN;
	playgroundMocks.period.mockReset();
	playgroundMocks.profile.mockReset();
	playgroundMocks.search.mockReset();
});

describe("prompt playground API", () => {
	it("rejects incomplete requests for every playground", async () => {
		const responses = await Promise.all([
			PERIOD({
				request: post("/api/prompt-playground/period-digest", {}),
			}),
			PROFILE({
				request: post("/api/prompt-playground/profile-analysis", {}),
			}),
			SEARCH({
				request: post("/api/prompt-playground/search-discussion", {}),
			}),
		]);

		expect(responses.map((response) => response.status)).toEqual([
			400, 400, 400,
		]);
	});

	it("denies cross-origin requests for every playground", async () => {
		process.env.BIRDCLAW_WEB_TOKEN = "secret";
		const headers = {
			origin: "https://evil.example",
			"x-birdclaw-token": "secret",
		};
		const responses = await Promise.all([
			PERIOD({
				request: post(
					"/api/prompt-playground/period-digest",
					periodRequest,
					headers,
				),
			}),
			PROFILE({
				request: post(
					"/api/prompt-playground/profile-analysis",
					profileRequest,
					headers,
				),
			}),
			SEARCH({
				request: post(
					"/api/prompt-playground/search-discussion",
					searchRequest,
					headers,
				),
			}),
		]);

		expect(responses.map((response) => response.status)).toEqual([
			403, 403, 403,
		]);
	});

	it("returns validated profile output and streams Today and Discuss output", async () => {
		playgroundMocks.period.mockImplementation(
			(_options: unknown, handlers: { onEvent?: (event: unknown) => void }) =>
				Effect.sync(() => {
					handlers.onEvent?.({ type: "done", result: periodResult() });
				}),
		);
		playgroundMocks.profile.mockReturnValue(Effect.succeed(profileResult()));
		playgroundMocks.search.mockImplementation(
			(_options: unknown, handlers: { onEvent?: (event: unknown) => void }) =>
				Effect.sync(() => {
					handlers.onEvent?.({ type: "done", result: searchResult() });
				}),
		);

		const period = await PERIOD({
			request: post("/api/prompt-playground/period-digest", periodRequest),
		});
		const profile = await PROFILE({
			request: post("/api/prompt-playground/profile-analysis", profileRequest),
		});
		const search = await SEARCH({
			request: post("/api/prompt-playground/search-discussion", searchRequest),
		});

		expect(await period.text()).toContain('"title":"Today"');
		expect(await profile.json()).toMatchObject({
			ok: true,
			result: { analysis: { title: "Alice" } },
		});
		expect(await search.text()).toContain('"title":"Discuss"');
	});

	it("converts typed and untyped stream failures into terminal events", async () => {
		playgroundMocks.period.mockReturnValue(Effect.fail("raw failure"));
		playgroundMocks.search.mockReturnValue(
			Effect.fail(new Error("search failed")),
		);

		const period = await PERIOD({
			request: post("/api/prompt-playground/period-digest", periodRequest),
		});
		const search = await SEARCH({
			request: post("/api/prompt-playground/search-discussion", searchRequest),
		});

		expect(await period.text()).toContain("Today playground failed");
		expect(await search.text()).toContain("search failed");

		playgroundMocks.period.mockReturnValue(
			Effect.fail(new Error("period failed")),
		);
		playgroundMocks.search.mockReturnValue(Effect.fail("raw failure"));
		const typedPeriod = await PERIOD({
			request: post("/api/prompt-playground/period-digest", periodRequest),
		});
		const untypedSearch = await SEARCH({
			request: post("/api/prompt-playground/search-discussion", searchRequest),
		});
		expect(await typedPeriod.text()).toContain("period failed");
		expect(await untypedSearch.text()).toContain("Discuss playground failed");
	});
});
