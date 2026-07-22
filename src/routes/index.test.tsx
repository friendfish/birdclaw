import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";

vi.mock("#/components/TimelineCard", () => ({
	TimelineCard: ({
		item,
		onReply,
	}: {
		item: { id: string; text: string };
		onReply: (tweetId: string) => void;
	}) => (
		<button onClick={() => onReply(item.id)} type="button">
			{item.text}
		</button>
	),
}));

import { HomeRouteView as HomeRoute } from "./index";

const dataSourcesResponse = (birdWorks: boolean) => ({
	generatedAt: "2026-05-15T12:00:00.000Z",
	sources: [
		{
			source: "bird" as const,
			label: "bird",
			works: birdWorks,
			status: birdWorks ? ("ok" as const) : ("error" as const),
			detail: birdWorks ? "ready" : "not configured",
			accounts: [],
		},
	],
	capabilities: [],
});

function statusResponse() {
	return Response.json({
		stats: { home: 3, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
		transport: { statusText: "local" },
		accounts: [],
		archives: [],
	});
}

describe("home route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("loads timeline items and posts replies", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) return statusResponse();
				if (url.endsWith("/api/data-sources")) {
					return Response.json(dataSourcesResponse(false));
				}
				if (url.includes("/api/query")) {
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "tweet_1", text: "Ship it" }],
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ ok: true }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(window, "prompt").mockReturnValue("On it.");

		render(<HomeRoute />);

		expect(await screen.findByText("Ship it")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Ship it" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/action",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});

	it("restores timeline data without refetching after a sidebar-style remount", async () => {
		let queryCalls = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return statusResponse();
			if (url.endsWith("/api/data-sources")) {
				return Response.json(dataSourcesResponse(false));
			}
			if (url.includes("/api/query")) {
				queryCalls += 1;
				return Response.json({
					resource: "home",
					items: [{ id: "tweet_cached", text: "Cached post" }],
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const first = render(<HomeRoute />);
		expect(await screen.findByText("Cached post")).toBeInTheDocument();
		first.unmount();

		render(<HomeRoute />, { queryClient: first.queryClient });

		expect(screen.getByText("Cached post")).toBeInTheDocument();
		expect(queryCalls).toBe(1);
	});

	it("shows reply transport errors without dropping the timeline", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) return statusResponse();
				if (url.endsWith("/api/data-sources")) {
					return Response.json(dataSourcesResponse(false));
				}
				if (url.includes("/api/query")) {
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "tweet_1", text: "Ship it" }],
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ message: "reply denied" }), {
						status: 500,
					});
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(window, "prompt").mockReturnValue("On it.");

		render(<HomeRoute />);

		expect(await screen.findByText("Ship it")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Ship it" }));

		expect(await screen.findByText("reply denied")).toBeInTheDocument();
		expect(screen.getByText("Ship it")).toBeInTheDocument();
	});

	it("trims search terms, changes reply filters, and ignores blank replies", async () => {
		const queryUrls: URL[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) return statusResponse();
				if (url.endsWith("/api/data-sources")) {
					return Response.json(dataSourcesResponse(false));
				}
				if (url.includes("/api/query")) {
					queryUrls.push(new URL(url));
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "tweet_search", text: "Find me" }],
						}),
					);
				}
				if (url.endsWith("/api/action") && init?.method === "POST") {
					return new Response(JSON.stringify({ ok: true }));
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(window, "prompt").mockReturnValue("  ");

		render(<HomeRoute />);

		expect(await screen.findByText("Find me")).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText("Search local timeline"), {
			target: { value: "  signal  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Replied" }));

		await waitFor(() => {
			const queryUrl = queryUrls.at(-1);
			expect(queryUrl?.searchParams.get("search")).toBe("signal");
			expect(queryUrl?.searchParams.get("replyFilter")).toBe("replied");
		});

		fireEvent.click(screen.getByRole("button", { name: "Find me" }));
		expect(fetchMock).not.toHaveBeenCalledWith(
			"/api/action",
			expect.anything(),
		);
	});

	it("runs a live timeline sync scoped to the active feed and reloads local data", async () => {
		const queryUrls: URL[] = [];
		const syncBodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) return statusResponse();
				if (url.endsWith("/api/data-sources")) {
					return Response.json(dataSourcesResponse(false));
				}
				if (url.includes("/api/query")) {
					queryUrls.push(new URL(url));
					return new Response(
						JSON.stringify({
							resource: "home",
							items: [{ id: "tweet_sync", text: "Fresh post" }],
						}),
					);
				}
				if (url.endsWith("/api/sync") && init?.body) {
					syncBodies.push(JSON.parse(String(init.body)));
					return new Response(
						JSON.stringify({
							id: "sync_timeline_1",
							kind: "timeline",
							status: "succeeded",
							startedAt: "2026-05-15T12:00:00.000Z",
							summary: "Synced 12 items",
							inProgress: false,
							result: {
								ok: true,
								kind: "timeline",
								summary: "Synced 12 items",
								steps: [],
							},
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<HomeRoute />);

		expect(await screen.findByText("Fresh post")).toBeInTheDocument();
		const initialQueryCount = queryUrls.length;
		fireEvent.click(screen.getByRole("button", { name: "Sync Following" }));

		await waitFor(() => {
			expect(syncBodies).toEqual([{ kind: "timeline", feed: "following" }]);
			expect(queryUrls.length).toBeGreaterThan(initialQueryCount);
		});
		expect(screen.getByText("Synced 12 items")).toBeInTheDocument();
		expect(queryUrls.at(-1)?.searchParams.get("feed")).toBe("following");
	});

	it("shows a retryable error when timeline loading fails", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return statusResponse();
			if (url.endsWith("/api/data-sources")) {
				return Response.json(dataSourcesResponse(false));
			}
			if (url.includes("/api/query")) {
				throw "Timeline unavailable";
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<HomeRoute />);

		expect(await screen.findByText("Could not load posts")).toBeInTheDocument();
		expect(screen.getByText("Timeline unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(4);
		});
	});

	it("hides the For You tab when bird is not available", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return statusResponse();
			if (url.endsWith("/api/data-sources")) {
				return Response.json(dataSourcesResponse(false));
			}
			if (url.includes("/api/query")) {
				return Response.json({ resource: "home", items: [] });
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<HomeRoute />);

		await screen.findByText("No posts in this view");
		expect(screen.queryByRole("button", { name: "For You" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Following" })).toBeNull();
	});

	it("shows both feed tabs, defaults to For You, and scopes queries/sync per tab when bird works", async () => {
		const queryUrls: URL[] = [];
		const syncBodies: unknown[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) return statusResponse();
				if (url.endsWith("/api/data-sources")) {
					return Response.json(dataSourcesResponse(true));
				}
				if (url.includes("/api/query")) {
					const parsed = new URL(url);
					queryUrls.push(parsed);
					const feed = parsed.searchParams.get("feed");
					return Response.json({
						resource: "home",
						items: [
							{
								id: feed === "for_you" ? "tweet_fyp" : "tweet_following",
								text: feed === "for_you" ? "For You post" : "Following post",
							},
						],
					});
				}
				if (url.endsWith("/api/sync") && init?.body) {
					syncBodies.push(JSON.parse(String(init.body)));
					return Response.json({
						id: "sync_timeline_2",
						kind: "timeline",
						status: "succeeded",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "Synced 3 items",
						inProgress: false,
						result: {
							ok: true,
							kind: "timeline",
							summary: "Synced 3 items",
							steps: [],
						},
					});
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<HomeRoute />);

		expect(await screen.findByText("For You post")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "For You" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		fireEvent.click(screen.getByRole("button", { name: "Following" }));
		expect(await screen.findByText("Following post")).toBeInTheDocument();
		expect(screen.queryByText("For You post")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Sync Following" }));
		await waitFor(() => {
			expect(syncBodies).toEqual([{ kind: "timeline", feed: "following" }]);
		});
	});
});
