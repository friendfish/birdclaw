import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { TodayRouteView as TodayRoute } from "./today";

function digestResult(
	label: string,
	markdown: string,
	updatedAt = "2026-08-06T08:30:00.000Z",
) {
	return {
		context: {
			window: {
				label,
				since: "2026-08-06T00:00:00.000Z",
				until: updatedAt,
			},
			includeDms: false,
			contentSource: "all",
			counts: {
				home: 3,
				mentions: 2,
				authored: 0,
				likes: 0,
				bookmarks: 0,
				dms: 0,
				links: 1,
			},
			tweets: [],
			dms: [],
			links: [],
			hash: `${label}:${updatedAt}`,
		},
		digest: {
			title: label,
			summary: `${label} summary`,
			keyTopics: [],
			notableLinks: [],
			people: [],
			actionItems: [],
			sourceTweetIds: [],
		},
		markdown,
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		parseStatus: "structured" as const,
		cached: true,
		updatedAt,
	};
}

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	});
}

function dataSourcesResponse() {
	return {
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
	};
}

function metadataResponse(
	overrides: Partial<{
		isGenerating: boolean;
		isStale: boolean;
		activeStatus: { label: string; detail?: string } | null;
		result: unknown;
		runState: unknown;
	}> = {},
) {
	return {
		ok: true,
		isGenerating: false,
		isStale: false,
		activeStatus: null,
		result: digestResult("Today", "# Stable Today"),
		runState: null,
		migration: null,
		...overrides,
	};
}

function currentSearch(period: "today" | "24h" = "today") {
	return {
		period,
		includeDms: true,
		contentSource: "all" as const,
		archiveDate: "",
	};
}

describe("today route", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		focusManager.setFocused(undefined);
		vi.unstubAllGlobals();
	});

	it("renders the persistent current result and generation timestamp without Save or DMs", async () => {
		const requestedPaths: string[] = [];
		const requestedIncludeDms: Array<string | null> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				requestedPaths.push(url.pathname);
				if (url.pathname === "/api/data-sources") {
					return jsonResponse(dataSourcesResponse());
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/period-digest-metadata") {
					requestedIncludeDms.push(url.searchParams.get("includeDms"));
					return jsonResponse(metadataResponse());
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

		render(<TodayRoute searchState={currentSearch()} />);

		expect(
			await screen.findByRole("heading", { name: "Stable Today", level: 1 }),
		).toBeInTheDocument();
		const generatedAt = screen.getByLabelText("Generated at");
		expect(generatedAt).toHaveAttribute("datetime", "2026-08-06T08:30:00.000Z");
		expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
		expect(screen.queryByLabelText("DMs")).toBeNull();
		expect(requestedPaths).not.toContain("/api/digest-archive-dates");
		expect(requestedPaths).not.toContain("/api/digest-archive-entry");
		expect(requestedPaths).not.toContain("/api/digest-archive-save");
		expect(requestedIncludeDms).toEqual(["false"]);
	});

	it("requests one freshness fallback for stale content without clearing it", async () => {
		let freshnessRequests = 0;
		const freshnessMethods: Array<string | undefined> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse(dataSourcesResponse());
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return jsonResponse(metadataResponse({ isStale: true }));
				}
				if (url.pathname === "/api/period-digest-freshness") {
					freshnessMethods.push(init?.method);
					freshnessRequests += 1;
					return jsonResponse({
						ok: true,
						triggered: true,
						runId: "fresh-run",
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

		render(<TodayRoute searchState={currentSearch()} />);

		expect(
			await screen.findByRole("heading", { name: "Stable Today", level: 1 }),
		).toBeVisible();
		await waitFor(() => expect(freshnessRequests).toBe(1));
		expect(freshnessMethods).toEqual(["POST"]);
		expect(
			screen.getByRole("heading", { name: "Stable Today", level: 1 }),
		).toBeVisible();
	});

	it("retries freshness once for each newly failed run", async () => {
		let freshnessRequests = 0;
		let runVersion = 1;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse(dataSourcesResponse());
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return jsonResponse(
						metadataResponse({
							isStale: true,
							runState: {
								runId: `failed-${String(runVersion)}`,
								phase: "failed",
								finishedAt:
									runVersion === 2
										? "2026-08-06T12:00:00.000Z"
										: "2026-08-06T11:00:00.000Z",
							},
						}),
					);
				}
				if (url.pathname === "/api/period-digest-freshness") {
					freshnessRequests += 1;
					return jsonResponse({
						ok: true,
						triggered: false,
						reason: "not-due",
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

		render(<TodayRoute searchState={currentSearch()} />);
		await waitFor(() => expect(freshnessRequests).toBe(1));
		focusManager.setFocused(false);
		runVersion = 2;
		focusManager.setFocused(true);
		await waitFor(() => expect(freshnessRequests).toBe(2));
		expect(
			screen.getByRole("heading", { name: "Stable Today", level: 1 }),
		).toBeVisible();
	});

	it("keeps old content visible while the period batch is generating", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse(dataSourcesResponse());
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return jsonResponse(
						metadataResponse({
							isGenerating: true,
							isStale: true,
							activeStatus: {
								label: "Generating current digest",
								detail: "1/3 complete · Following",
							},
							runState: { runId: "run-new", phase: "generating" },
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

		render(<TodayRoute searchState={currentSearch()} />);

		expect(
			await screen.findByRole("heading", { name: "Stable Today", level: 1 }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Generating current digest · 1/3 complete · Following"),
		).toBeVisible();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled(),
		);
	});

	it("does not clear the current result when Refresh requests a new batch", async () => {
		let resolveTrigger!: (response: Response) => void;
		let triggerRequest: RequestInit | undefined;
		const triggerResponse = new Promise<Response>((resolve) => {
			resolveTrigger = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse(dataSourcesResponse());
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return jsonResponse(metadataResponse());
				}
				if (url.pathname === "/api/period-digest-runs") {
					triggerRequest = init;
					return triggerResponse;
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

		render(<TodayRoute searchState={currentSearch()} />);
		await screen.findByRole("heading", { name: "Stable Today", level: 1 });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

		expect(
			screen.getByRole("heading", { name: "Stable Today", level: 1 }),
		).toBeVisible();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled(),
		);
		expect(triggerRequest?.method).toBe("POST");
		expect(JSON.parse(String(triggerRequest?.body))).toEqual({
			period: "today",
			requestedSource: "all",
			liveSync: true,
		});

		resolveTrigger(jsonResponse({ ok: true, runId: "run-new", joined: false }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
		);
	});

	it("shows a first-generation state without inventing content", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse(dataSourcesResponse());
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return jsonResponse(
						metadataResponse({
							isGenerating: true,
							isStale: true,
							activeStatus: { label: "Refreshing information sources" },
							result: null,
							runState: { runId: "first-run", phase: "syncing" },
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

		render(<TodayRoute searchState={currentSearch("24h")} />);

		expect(
			await screen.findByText(
				"Generating the first current digest in the background.",
			),
		).toBeVisible();
		expect(
			screen.queryByRole("heading", { level: 1, name: /stable/i }),
		).toBeNull();
	});

	it("treats whitespace-only metadata content as waiting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse(dataSourcesResponse());
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/period-digest-metadata") {
					return jsonResponse(
						metadataResponse({
							result: digestResult("Today", " \n\t"),
						}),
					);
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

		const { container } = render(<TodayRoute searchState={currentSearch()} />);

		expect(await screen.findByText("Waiting")).toBeVisible();
		expect(screen.getByText("Waiting for the first tokens...")).toBeVisible();
		expect(screen.queryByText(/Cached/)).toBeNull();
		expect(screen.queryByLabelText("Generated at")).toBeNull();
		expect(container.querySelector("article")).toBeNull();
	});

	it("keeps Yesterday on the archive read path", async () => {
		const entryDates: Array<string | null> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/data-sources") {
					return jsonResponse(dataSourcesResponse());
				}
				if (url.pathname === "/api/digest-archive-status") {
					return jsonResponse({ ok: true, runningPeriods: [] });
				}
				if (url.pathname === "/api/digest-archive-dates") {
					return jsonResponse({
						ok: true,
						dates: [{ date: "2026-08-05", contentSources: ["all"] }],
					});
				}
				if (url.pathname === "/api/digest-archive-entry") {
					entryDates.push(url.searchParams.get("date"));
					return jsonResponse({
						ok: true,
						result: digestResult(
							"Yesterday",
							"# Archived Yesterday",
							"2026-08-06T01:00:00.000Z",
						),
					});
				}
				throw new Error(`Unexpected fetch ${url.pathname}`);
			}),
		);

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
				name: "Archived Yesterday",
				level: 1,
			}),
		).toBeInTheDocument();
		expect(entryDates).toEqual(["2026-08-05"]);
		expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
	});
});
