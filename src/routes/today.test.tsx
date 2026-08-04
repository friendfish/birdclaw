import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ndjsonResponse } from "#/test/ndjson";
import { renderWithQueryClient as render } from "#/test/render";
import { TodayRouteView as TodayRoute } from "./today";

const authorProfile = {
	id: "profile_alice",
	handle: "alice",
	displayName: "Alice",
	bio: "Builds useful things.",
	followersCount: 1200,
	followingCount: 200,
	avatarHue: 42,
	createdAt: "2020-01-01T00:00:00.000Z",
};

const hydratedAuthorProfile = {
	...authorProfile,
	displayName: "Alice Fresh",
	avatarUrl: "https://pbs.twimg.com/profile_images/alice/avatar.jpg",
};

function digestResult(label: string, markdown: string, includeDms = false) {
	return {
		context: {
			window: {
				label,
				since: "2026-05-16T00:00:00.000Z",
				until: "2026-05-16T12:00:00.000Z",
			},
			includeDms,
			counts: {
				home: 3,
				mentions: 2,
				authored: 1,
				likes: 1,
				bookmarks: 1,
				dms: includeDms ? 1 : 0,
				links: 4,
			},
			tweets: [
				{
					id: "tweet_1",
					url: "https://x.com/alice/status/tweet_1",
					source: "mentions",
					author: "alice",
					name: "Alice",
					authorProfile,
					createdAt: "2026-05-16T10:00:00.000Z",
					text: "Peter should see this.",
					likeCount: 12,
					liked: false,
					bookmarked: false,
					needsReply: true,
				},
			],
			dms: [],
			links: [],
			hash: label,
		},
		digest: {
			title: label,
			summary: `${label} summary`,
			keyTopics: [
				{
					title: "Useful signal",
					summary: "Alice shared something worth a reply.",
					tweetIds: ["tweet_1"],
					handles: ["@alice"],
				},
			],
			notableLinks: [
				{
					title: "Example",
					url: "https://example.com",
					why: "Worth reading.",
					sourceTweetIds: ["tweet_1"],
				},
				{
					title: "Unsafe",
					url: "javascript:alert(1)",
					why: "Should render as inert text.",
					sourceTweetIds: ["tweet_1"],
				},
			],
			people: [
				{ handle: "alice", name: "Alice", why: "Shared useful signal." },
			],
			actionItems: [
				{ kind: "reply", label: "Reply to Alice", tweetId: "tweet_1" },
			],
			sourceTweetIds: ["tweet_1"],
		},
		markdown,
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		parseStatus: "structured" as const,
		cached: false,
		updatedAt: "2026-05-16T12:00:00.000Z",
	};
}

function periodDigestMetadataResponse(
	overrides: Partial<{
		isGenerating: boolean;
		activeStatus: { label: string; detail?: string } | null;
		result: unknown;
	}> = {},
) {
	return Response.json({
		ok: true,
		isGenerating: false,
		activeStatus: null,
		result: null,
		...overrides,
	});
}

describe("today route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("streams a digest and reloads when controls change", async () => {
		const urls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			urls.push(url);
			if (url.pathname === "/api/profile-hydrate") {
				return new Response(
					JSON.stringify({
						ok: true,
						results: [
							{
								handle: "alice",
								status: "hit",
								source: "bird",
								profile: hydratedAuthorProfile,
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			}
			if (url.pathname === "/api/period-digest-metadata") {
				return periodDigestMetadataResponse();
			}
			const period = url.searchParams.get("period") ?? "today";
			const includeDms = url.searchParams.get("includeDms") === "true";
			const label = period === "24h" ? "Last 24 hours" : "Today";
			const markdown = includeDms
				? "# With DMs\n\n## What people are talking about\n\n- **Reply:** ask @alice about tweet_1"
				: `# ${label}\n\n## What people are talking about\n\n- **Reply:** ask @alice about tweet_1`;
			return ndjsonResponse([
				{ type: "delta", delta: `${markdown}\n` },
				{ type: "done", result: digestResult(label, markdown, includeDms) },
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);

		expect(
			await screen.findByRole("heading", { name: "Today", level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", {
				name: "What people are talking about",
				level: 2,
			}),
		).toBeInTheDocument();
		expect(screen.queryByText("Today summary")).toBeNull();
		expect(screen.queryByText("Useful signal")).toBeNull();
		expect(screen.queryByText(/Action items/i)).toBeNull();
		expect(screen.queryByText("# Today")).not.toBeInTheDocument();
		expect(screen.getByText("Reply:")).toBeInTheDocument();
		const aliceLink = screen.getByRole("link", { name: "@alice" });
		expect(aliceLink).toHaveAttribute("href", "/profiles/alice");
		expect(screen.getByRole("link", { name: "tweet_1" })).toHaveAttribute(
			"href",
			"https://x.com/alice/status/tweet_1",
		);
		expect(
			screen.getByText("3 home · 2 mentions · 4 links"),
		).toBeInTheDocument();
		const todayButton = screen.getByRole("button", { name: "Today" });
		const hour24Button = screen.getByRole("button", { name: "24h" });
		expect(todayButton).toHaveAttribute("aria-pressed", "true");
		expect(todayButton).toHaveClass(
			"bg-[var(--accent-soft)]!",
			"text-[var(--accent)]!",
		);
		expect(hour24Button).toHaveAttribute("aria-pressed", "false");
		await waitFor(() =>
			expect(urls.some((url) => url.pathname === "/api/profile-hydrate")).toBe(
				true,
			),
		);
		fireEvent.pointerEnter(aliceLink.parentElement as Element);
		await screen.findByText("Alice Fresh");
		expect(screen.getByRole("img", { name: "Alice Fresh" })).toHaveAttribute(
			"src",
			expect.stringContaining("/api/avatar?profileId=profile_alice&v="),
		);

		fireEvent.click(screen.getByRole("button", { name: "24h" }));
		expect(
			await screen.findByRole("heading", { name: "Last 24 hours", level: 1 }),
		).toBeInTheDocument();
		expect(todayButton).toHaveAttribute("aria-pressed", "false");
		expect(hour24Button).toHaveAttribute("aria-pressed", "true");
		expect(hour24Button).toHaveClass(
			"bg-[var(--accent-soft)]!",
			"text-[var(--accent)]!",
		);

		fireEvent.click(screen.getByLabelText("DMs"));
		expect(
			await screen.findByRole("heading", { name: "With DMs", level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByText("3 home · 2 mentions · 4 links · 1 DMs"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		await waitFor(() =>
			expect(
				urls.some((url) => url.searchParams.get("refresh") === "true"),
			).toBe(true),
		);
		expect(
			urls.some(
				(url) =>
					url.searchParams.get("period") === "24h" &&
					url.searchParams.get("includeDms") === "true" &&
					url.searchParams.get("liveSync") === "false",
			),
		).toBe(true);
	}, 15_000);

	it("scopes the digest request by content source and hides For You without bird", async () => {
		const urls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			// fetchDataSources() passes a bare relative path (unlike digestUrl(),
			// which is already absolute); resolve against a base like a real
			// browser fetch() would instead of letting new URL() throw.
			const url = new URL(String(input), "http://localhost");
			urls.push(url);
			if (url.pathname === "/api/data-sources") {
				return Response.json({
					generatedAt: "2026-05-16T00:00:00.000Z",
					sources: [],
					capabilities: [],
				});
			}
			if (url.pathname === "/api/profile-hydrate") {
				return new Response(JSON.stringify({ ok: true, results: [] }), {
					headers: { "content-type": "application/json" },
				});
			}
			if (url.pathname === "/api/period-digest-metadata") {
				return periodDigestMetadataResponse();
			}
			const contentSource = url.searchParams.get("contentSource") ?? "all";
			const markdown = `# ${contentSource}\n\n## What people are talking about\n\n- signal`;
			return ndjsonResponse([
				{ type: "delta", delta: `${markdown}\n` },
				{ type: "done", result: digestResult(contentSource, markdown) },
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);

		expect(
			await screen.findByRole("heading", { name: "all", level: 1 }),
		).toBeInTheDocument();
		// bird is unavailable (empty data sources), so For You never renders.
		expect(screen.queryByRole("button", { name: "For You" })).toBeNull();
		expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		fireEvent.click(screen.getByRole("button", { name: "Following" }));
		expect(
			await screen.findByRole("heading", { name: "following", level: 1 }),
		).toBeInTheDocument();
		expect(
			urls.some(
				(url) =>
					url.pathname === "/api/period-digest" &&
					url.searchParams.get("contentSource") === "following",
			),
		).toBe(true);
	});

	it("shows For You and honors it once bird is available", async () => {
		const urls: URL[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			// fetchDataSources() passes a bare relative path (unlike digestUrl(),
			// which is already absolute); resolve against a base like a real
			// browser fetch() would instead of letting new URL() throw.
			const url = new URL(String(input), "http://localhost");
			urls.push(url);
			if (url.pathname === "/api/data-sources") {
				return Response.json({
					generatedAt: "2026-05-16T00:00:00.000Z",
					sources: [
						{
							source: "bird",
							label: "bird",
							works: true,
							status: "ok",
							detail: "ready",
							accounts: [],
						},
					],
					capabilities: [],
				});
			}
			if (url.pathname === "/api/profile-hydrate") {
				return new Response(JSON.stringify({ ok: true, results: [] }), {
					headers: { "content-type": "application/json" },
				});
			}
			if (url.pathname === "/api/period-digest-metadata") {
				return periodDigestMetadataResponse();
			}
			const contentSource = url.searchParams.get("contentSource") ?? "all";
			const markdown = `# ${contentSource}\n\n## What people are talking about\n\n- signal`;
			return ndjsonResponse([
				{ type: "delta", delta: `${markdown}\n` },
				{ type: "done", result: digestResult(contentSource, markdown) },
			]);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);
		await screen.findByRole("heading", { name: "all", level: 1 });

		const forYouButton = await screen.findByRole("button", {
			name: "For You",
		});
		fireEvent.click(forYouButton);
		expect(
			await screen.findByRole("heading", { name: "for_you", level: 1 }),
		).toBeInTheDocument();
		expect(forYouButton).toHaveAttribute("aria-pressed", "true");
		expect(
			urls.some(
				(url) =>
					url.pathname === "/api/period-digest" &&
					url.searchParams.get("contentSource") === "for_you",
			),
		).toBe(true);
	});

	it("exports a completed digest through the browser PDF flow", async () => {
		document.title = "birdclaw";
		const printMock = vi.spyOn(window, "print").mockImplementation(() => {
			expect(document.title).toBe("BirdClaw Today digest");
			window.dispatchEvent(new Event("afterprint"));
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return periodDigestMetadataResponse();
				}
				const markdown = "# Today\n\nDone.";
				return ndjsonResponse([
					{ type: "delta", delta: markdown },
					{ type: "done", result: digestResult("Today", markdown) },
				]);
			}),
		);

		render(<TodayRoute />);

		await screen.findByRole("heading", { name: "Today", level: 1 });
		const exportButton = screen.getByRole("button", { name: "Export PDF" });
		expect(exportButton).toBeEnabled();

		fireEvent.click(exportButton);

		expect(printMock).toHaveBeenCalledTimes(1);
		expect(document.title).toBe("birdclaw");
	});

	it("does not export a partial digest after the stream fails", async () => {
		const printMock = vi.spyOn(window, "print").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/period-digest-metadata") {
					return periodDigestMetadataResponse();
				}
				return ndjsonResponse([
					{ type: "delta", delta: "# Partial digest" },
					{ type: "error", error: "Digest generation failed" },
				]);
			}),
		);

		render(<TodayRoute />);

		await screen.findByRole("heading", { name: "Partial digest", level: 1 });
		await screen.findByRole("alert");
		expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull();
		expect(printMock).not.toHaveBeenCalled();
	});

	it("shows request errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: false,
							message:
								"Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
						}),
						{
							headers: { "content-type": "application/json" },
							status: 403,
						},
					),
			),
		);

		render(<TodayRoute />);

		expect(
			await screen.findByText(
				"Digest request failed (403): Remote API access requires BIRDCLAW_ALLOW_REMOTE_WEB=1 for a trusted private proxy, or BIRDCLAW_WEB_TOKEN for tokened access",
			),
		).toBeInTheDocument();
	});

	it("shows an actionable message when the digest connection drops", async () => {
		let digestCalls = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/data-sources")) {
				return Response.json({
					generatedAt: "2026-05-15T12:00:00.000Z",
					sources: [],
					capabilities: [],
				});
			}
			if (url.includes("/api/digest-archive-status")) {
				return Response.json({ ok: true, runningPeriods: [] });
			}
			if (url.includes("/api/period-digest-metadata")) {
				return periodDigestMetadataResponse();
			}
			digestCalls += 1;
			throw new TypeError("network error");
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<TodayRoute />);

		expect(
			await screen.findByText(
				"Digest connection was interrupted while starting digest. Retry to continue.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Digest failed")).toBeInTheDocument();
		expect(
			screen.getByText("No digest was generated. Retry to start a new run."),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Waiting for the first tokens..."),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(digestCalls).toBe(2));
	});

	it("shows fetch status before the first markdown token", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/profile-hydrate") {
					return new Response(JSON.stringify({ ok: true, results: [] }), {
						headers: { "content-type": "application/json" },
					});
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return periodDigestMetadataResponse();
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(streamController) {
							controller = streamController;
							streamController.enqueue(
								encoder.encode(
									`${JSON.stringify({
										type: "status",
										label: "Fetching home timeline from X",
									})}\n`,
								),
							);
						},
					}),
					{ headers: { "content-type": "application/x-ndjson" } },
				);
			}),
		);

		render(<TodayRoute />);

		expect(
			await screen.findAllByText("Fetching home timeline from X"),
		).not.toHaveLength(0);

		const markdown = "# Today\n\nDone.";
		await act(async () => {
			controller?.enqueue(
				encoder.encode(
					[
						JSON.stringify({ type: "delta", delta: markdown }),
						JSON.stringify({
							type: "done",
							result: digestResult("Today", markdown),
						}),
						"",
					].join("\n"),
				),
			);
			controller?.close();
		});

		expect(
			await screen.findByRole("heading", { name: "Today", level: 1 }),
		).toBeInTheDocument();
	});

	it("shows streamed error events", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/period-digest-metadata") {
					return periodDigestMetadataResponse();
				}
				return ndjsonResponse([{ type: "error", error: "model failed" }]);
			}),
		);

		render(<TodayRoute />);

		expect(await screen.findByText("model failed")).toBeInTheDocument();
	});

	describe("background-detached generation (resume instead of restart)", () => {
		it("adopts a fresh cached result from metadata without starting a new generation request", async () => {
			let generationCalls = 0;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return Response.json({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return periodDigestMetadataResponse({
						isGenerating: false,
						result: digestResult(
							"Today",
							"# Today\n\nAlready generated in the background.",
						),
					});
				}
				if (url.pathname === "/api/profile-hydrate") {
					return Response.json({ ok: true, results: [] });
				}
				if (url.pathname === "/api/digest-archive-status") {
					return Response.json({ ok: true, runningPeriods: [] });
				}
				generationCalls += 1;
				return ndjsonResponse([
					{ type: "done", result: digestResult("Today", "# Should not run") },
				]);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(<TodayRoute />);

			expect(
				await screen.findByRole("heading", { name: "Today", level: 1 }),
			).toBeInTheDocument();
			expect(
				screen.getByText("Already generated in the background."),
			).toBeInTheDocument();
			expect(generationCalls).toBe(0);
		});

		it("watches an in-progress background generation instead of starting a duplicate request", async () => {
			let generationCalls = 0;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return Response.json({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return periodDigestMetadataResponse({
						isGenerating: true,
						activeStatus: {
							label: "Streaming AI summary",
							detail: "background run from another tab",
						},
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return Response.json({ ok: true, runningPeriods: [] });
				}
				generationCalls += 1;
				return ndjsonResponse([
					{ type: "done", result: digestResult("Today", "# Should not run") },
				]);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(<TodayRoute />);

			expect(
				await screen.findAllByText(
					"Streaming AI summary · background run from another tab",
				),
			).not.toHaveLength(0);
			const refreshButton = await screen.findByRole("button", {
				name: /refresh/i,
			});
			expect(refreshButton).toBeDisabled();
			expect(generationCalls).toBe(0);
		});
	});

	describe("archived periods (Yesterday/Week)", () => {
		function jsonResponse(body: unknown) {
			return new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
			});
		}

		it("reads the latest archived entry for Yesterday, with no refresh button or DMs toggle", async () => {
			const entryDates: Array<string | null> = [];
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [
							{
								source: "bird",
								label: "bird",
								works: true,
								status: "ok",
								detail: "ready",
								accounts: [],
							},
						],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [
							{ date: "2026-07-21", contentSources: ["all"] },
							{ date: "2026-07-20", contentSources: ["all"] },
						],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					entryDates.push(url.searchParams.get("date"));
					return jsonResponse({
						ok: true,
						result: digestResult("Yesterday", "# Archived yesterday"),
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "all",
						archiveDate: "",
					}}
				/>,
			);

			expect(
				await screen.findByRole("heading", {
					name: "Archived yesterday",
					level: 1,
				}),
			).toBeInTheDocument();
			expect(entryDates).toEqual(["2026-07-21"]);
			expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
			expect(screen.queryByLabelText("DMs")).toBeNull();
		});

		it("reads a specific archived date when archiveDate is set", async () => {
			const entryDates: Array<string | null> = [];
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [
							{ date: "2026-07-21", contentSources: ["all"] },
							{ date: "2026-07-14", contentSources: ["all"] },
						],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					entryDates.push(url.searchParams.get("date"));
					return jsonResponse({
						ok: true,
						result: digestResult("Week of 7/14", "# Older week"),
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "week",
						includeDms: false,
						contentSource: "all",
						archiveDate: "2026-07-14",
					}}
				/>,
			);

			expect(
				await screen.findByRole("heading", { name: "Older week", level: 1 }),
			).toBeInTheDocument();
			expect(entryDates).toEqual(["2026-07-14"]);
		});

		it("shows a not-yet-scheduled empty state when a period has never archived", async () => {
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({ ok: true, dates: [] });
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "all",
						archiveDate: "",
					}}
				/>,
			);

			expect(
				await screen.findByText(/hasn't run on a schedule yet/i),
			).toBeInTheDocument();
		});

		it("polls an active archive run and replaces the pending source automatically", async () => {
			let datesCalls = 0;
			let entryCalls = 0;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [
							{
								source: "bird",
								label: "bird",
								works: true,
								status: "ok",
								detail: "ready",
								accounts: [],
							},
						],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({
						ok: true,
						runningPeriods: ["yesterday"],
						activeRuns: [
							{
								period: "yesterday",
								runDate: "2026-07-29",
								totalSources: 2,
							},
						],
					});
				}
				if (url.pathname === "/api/digest-archive-dates") {
					datesCalls += 1;
					return jsonResponse({
						ok: true,
						dates: [
							{
								date: "2026-07-29",
								contentSources: datesCalls === 1 ? ["all"] : ["all", "for_you"],
							},
						],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					entryCalls += 1;
					return jsonResponse({
						ok: true,
						result:
							entryCalls === 1
								? null
								: digestResult(
										"Yesterday For You",
										"# Scheduled For You is ready",
									),
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "for_you",
						archiveDate: "",
					}}
				/>,
			);

			expect(
				await screen.findByText("Generating scheduled digest 1/2"),
			).toBeInTheDocument();
			expect(
				screen.getByText("This source is still being generated."),
			).toBeInTheDocument();
			expect(screen.queryByText(/^Ready/)).toBeNull();
			expect(
				screen.queryByText(/No archived .*digest for this date/i),
			).toBeNull();

			expect(
				await screen.findByRole(
					"heading",
					{ name: "Scheduled For You is ready", level: 1 },
					{ timeout: 4_000 },
				),
			).toBeInTheDocument();
			expect(datesCalls).toBeGreaterThanOrEqual(2);
			expect(entryCalls).toBeGreaterThanOrEqual(2);
		});

		it("does not show a historical date as pending during the current run", async () => {
			const entryDates: Array<string | null> = [];
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({
						ok: true,
						runningPeriods: ["yesterday"],
						activeRuns: [
							{
								period: "yesterday",
								runDate: "2026-07-29",
								totalSources: 3,
							},
						],
					});
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [
							{
								date: "2026-07-29",
								contentSources: ["all"],
							},
							{
								date: "2026-07-28",
								contentSources: ["all", "following"],
							},
						],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					entryDates.push(url.searchParams.get("date"));
					return jsonResponse({ ok: true, result: null });
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "for_you",
						archiveDate: "2026-07-28",
					}}
				/>,
			);

			expect(
				await screen.findByText(/No archived .*digest for this date/i),
			).toBeInTheDocument();
			expect(
				screen.queryByText("This source is still being generated."),
			).toBeNull();
			expect(screen.queryByText(/Generating scheduled digest/)).toBeNull();
			expect(entryDates).toEqual(["2026-07-28"]);
		});

		it("uses the active run date before its first archive file exists", async () => {
			const entryDates: Array<string | null> = [];
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({
						ok: true,
						runningPeriods: ["yesterday"],
						activeRuns: [{ period: "yesterday", runDate: "2026-07-29" }],
					});
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [
							{
								date: "2026-07-28",
								contentSources: ["all", "following", "for_you"],
							},
						],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					entryDates.push(url.searchParams.get("date"));
					return jsonResponse({ ok: true, result: null });
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "for_you",
						archiveDate: "",
					}}
				/>,
			);

			expect(
				await screen.findByText("Generating scheduled digest 0/3"),
			).toBeInTheDocument();
			await waitFor(() => expect(entryDates[0]).toBe("2026-07-29"));
		});

		it("does not carry an active Yesterday date into Week after navigation", async () => {
			const entryRequests: string[] = [];
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({
						ok: true,
						runningPeriods: ["yesterday"],
						activeRuns: [{ period: "yesterday", runDate: "2026-07-29" }],
					});
				}
				if (url.pathname === "/api/digest-archive-dates") {
					const period = url.searchParams.get("period");
					return jsonResponse({
						ok: true,
						dates:
							period === "week"
								? [{ date: "2026-07-21", contentSources: ["all"] }]
								: [],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					const request = `${url.searchParams.get("period")}:${url.searchParams.get("date")}`;
					entryRequests.push(request);
					return jsonResponse({
						ok: true,
						result:
							request === "week:2026-07-21"
								? digestResult("Week archive", "# Correct Week archive")
								: null,
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			const { rerender } = render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "all",
						archiveDate: "",
					}}
				/>,
			);
			expect(
				await screen.findByText("Generating scheduled digest 0/3"),
			).toBeInTheDocument();

			rerender(
				<TodayRoute
					searchState={{
						period: "week",
						includeDms: false,
						contentSource: "all",
						archiveDate: "",
					}}
				/>,
			);

			expect(
				await screen.findByRole("heading", {
					name: "Correct Week archive",
					level: 1,
				}),
			).toBeInTheDocument();
			expect(entryRequests).toContain("week:2026-07-21");
			expect(entryRequests).not.toContain("week:2026-07-29");
		});

		it("fetches the final archive once more when the job becomes idle", async () => {
			let statusCalls = 0;
			let entryCalls = 0;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					statusCalls += 1;
					return jsonResponse(
						statusCalls === 1
							? {
									ok: true,
									runningPeriods: ["yesterday"],
									activeRuns: [{ period: "yesterday", runDate: "2026-07-29" }],
								}
							: { ok: true, runningPeriods: [], activeRuns: [] },
					);
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [
							{
								date: "2026-07-29",
								contentSources: ["all", "following", "for_you"],
							},
						],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					entryCalls += 1;
					return jsonResponse({
						ok: true,
						result:
							statusCalls > 1
								? digestResult("Yesterday For You", "# Final scheduled result")
								: null,
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "for_you",
						archiveDate: "",
					}}
				/>,
			);

			expect(
				await screen.findByText("This source is still being generated."),
			).toBeInTheDocument();
			expect(
				await screen.findByRole(
					"heading",
					{ name: "Final scheduled result", level: 1 },
					{ timeout: 8_000 },
				),
			).toBeInTheDocument();
			expect(statusCalls).toBeGreaterThanOrEqual(2);
			expect(entryCalls).toBeGreaterThanOrEqual(2);
		}, 8_000);

		it("disables Today's refresh button while a scheduled archive job holds the lock", async () => {
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: ["today"] });
				}
				if (url.pathname === "/api/profile-hydrate") {
					return jsonResponse({ ok: true, results: [] });
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return periodDigestMetadataResponse();
				}
				return ndjsonResponse([
					{ type: "delta", delta: "# Today\n" },
					{ type: "done", result: digestResult("Today", "# Today") },
				]);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(<TodayRoute />);

			const refreshButton = await screen.findByRole("button", {
				name: /refresh/i,
			});
			await waitFor(() => expect(refreshButton).toBeDisabled());
		});

		it("reads a completed Today source from the active scheduled archive", async () => {
			const requestedPaths: string[] = [];
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				requestedPaths.push(url.pathname);
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({
						ok: true,
						runningPeriods: ["today"],
						activeRuns: [
							{
								period: "today",
								runDate: "2026-07-29",
								totalSources: 3,
								phase: "generating",
								startedAt: "2026-07-29T00:00:00.000Z",
								lastHeartbeatAt: "2026-07-29T00:01:00.000Z",
								sources: {
									all: {
										state: "completed",
										attempts: 1,
										generatedAt: "2026-07-29T00:00:40.000Z",
									},
									for_you: { state: "running", attempts: 1 },
								},
							},
						],
						lastRuns: [],
					});
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					return jsonResponse({
						ok: true,
						result: digestResult(
							"Scheduled Today",
							"# Scheduled Today is ready",
						),
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(<TodayRoute />);

			expect(
				await screen.findByRole("heading", {
					name: "Scheduled Today is ready",
					level: 1,
				}),
			).toBeInTheDocument();
			expect(requestedPaths).not.toContain("/api/period-digest");
			expect(requestedPaths).not.toContain("/api/period-digest-metadata");
		});

		it("shows the active source as pending without starting a live Today digest", async () => {
			const requestedPaths: string[] = [];
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				requestedPaths.push(url.pathname);
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({
						ok: true,
						runningPeriods: ["today"],
						activeRuns: [
							{
								period: "today",
								runDate: "2026-07-29",
								totalSources: 3,
								phase: "generating",
								startedAt: "2026-07-29T00:00:00.000Z",
								lastHeartbeatAt: "2026-07-29T00:01:00.000Z",
								sources: {
									all: { state: "completed", attempts: 1 },
									for_you: { state: "running", attempts: 1 },
								},
							},
						],
						lastRuns: [],
					});
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [{ date: "2026-07-29", contentSources: ["all"] }],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					return jsonResponse({ ok: true, result: null });
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "today",
						includeDms: false,
						contentSource: "for_you",
						archiveDate: "",
					}}
				/>,
			);

			expect(
				await screen.findByText("This source is still being generated."),
			).toBeInTheDocument();
			expect(requestedPaths).not.toContain("/api/period-digest");
			expect(requestedPaths).not.toContain("/api/period-digest-metadata");
		});

		it("shows the latest scheduled source failure instead of a missing-archive message", async () => {
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [
							{
								source: "bird",
								label: "bird",
								works: true,
								status: "ok",
								detail: "ready",
								accounts: [],
							},
						],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({
						ok: true,
						runningPeriods: [],
						activeRuns: [],
						lastRuns: [
							{
								period: "yesterday",
								runDate: "2026-07-29",
								status: "failed",
								finishedAt: "2026-07-30T00:02:00.000Z",
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
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					return jsonResponse({ ok: true, result: null });
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "for_you",
						archiveDate: "",
					}}
				/>,
			);

			expect(
				await screen.findByText("Scheduled digest failed: attempt timed out"),
			).toBeInTheDocument();
			expect(
				screen.queryByText(/No archived .*digest for this date/i),
			).toBeNull();
		});

		it("exposes the digest generation timestamp on screen", async () => {
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse({
						generatedAt: "",
						sources: [],
						capabilities: [],
					});
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({
						ok: true,
						runningPeriods: [],
						activeRuns: [],
						lastRuns: [],
					});
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [{ date: "2026-07-29", contentSources: ["all"] }],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					return jsonResponse({
						ok: true,
						result: digestResult("Yesterday", "# Yesterday archive"),
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			});
			vi.stubGlobal("fetch", fetchMock);

			render(
				<TodayRoute
					searchState={{
						period: "yesterday",
						includeDms: false,
						contentSource: "all",
						archiveDate: "",
					}}
				/>,
			);

			const generatedAt = await screen.findByLabelText("Generated at");
			expect(generatedAt).toHaveAttribute(
				"datetime",
				"2026-05-16T12:00:00.000Z",
			);
		});
	});
});
