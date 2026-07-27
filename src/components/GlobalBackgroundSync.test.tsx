import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createTestQueryClient,
	renderWithQueryClient as render,
} from "#/test/render";
import { autoSyncStorageKey, lastSyncStorageKey } from "#/lib/auto-sync-keys";
import { queryKeys } from "#/lib/query-client";
import { GlobalBackgroundSync } from "./GlobalBackgroundSync";

function statusEnvelope(
	accounts: Array<{ id: string; isDefault: number }> = [],
) {
	return {
		stats: { home: 0, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
		transport: { statusText: "local" },
		accounts: accounts.map((account) => ({
			id: account.id,
			name: account.id,
			handle: `@${account.id}`,
			transport: "xurl",
			isDefault: account.isDefault,
			createdAt: "2026-05-15T12:00:00.000Z",
		})),
		archives: [],
	};
}

function renderWithAccounts(
	accounts: Array<{ id: string; isDefault: number }> = [],
) {
	const queryClient = createTestQueryClient();
	const envelope = statusEnvelope(accounts);
	queryClient.setQueryData(queryKeys.status, envelope);
	return { ...render(<GlobalBackgroundSync />, { queryClient }), queryClient };
}

function enableAutoSync(
	kind: string,
	accountId: string | undefined,
	scope: string | undefined,
	intervalMs = 5 * 60_000,
) {
	window.localStorage.setItem(
		autoSyncStorageKey(kind as never, accountId, scope),
		JSON.stringify({ enabled: true, intervalMs }),
	);
}

function syncCalls(fetchMock: ReturnType<typeof vi.fn>) {
	return fetchMock.mock.calls.filter((call) =>
		String(call[0]).endsWith("/api/sync"),
	);
}

let jobSeq = 0;
function syncJobResponse(kind: string, ok: boolean, summary: string) {
	jobSeq += 1;
	return Response.json({
		id: `sync_job_${jobSeq}`,
		kind,
		status: ok ? "succeeded" : "failed",
		startedAt: "2026-05-15T12:00:00.000Z",
		summary,
		inProgress: false,
		result: { ok, kind, summary, steps: [] },
	});
}

async function flushInitialCheck() {
	await act(async () => vi.advanceTimersByTimeAsync(1000));
}

describe("GlobalBackgroundSync", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		window.localStorage.clear();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("does nothing when no auto sync is enabled", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		renderWithAccounts();
		await flushInitialCheck();

		expect(syncCalls(fetchMock)).toHaveLength(0);
	});

	it("runs an unscoped kind (mentions) for the default account when due", async () => {
		enableAutoSync("mentions", undefined, undefined);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			if (url.endsWith("/api/sync")) {
				return syncJobResponse("mentions", true, "Synced 2 items");
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const started = vi.fn();
		const completed = vi.fn();
		window.addEventListener("birdclaw:auto-sync-started", started);
		window.addEventListener("birdclaw:auto-sync-completed", completed);

		renderWithAccounts();
		await flushInitialCheck();

		expect(syncCalls(fetchMock)).toHaveLength(1);
		expect(JSON.parse(String(syncCalls(fetchMock)[0]?.[1]?.body))).toEqual({
			kind: "mentions",
		});

		expect(started).toHaveBeenCalledWith(
			expect.objectContaining({
				detail: { kind: "mentions", accountId: "default", scope: undefined },
			}),
		);
		expect(completed).toHaveBeenCalledWith(
			expect.objectContaining({
				detail: expect.objectContaining({
					kind: "mentions",
					accountId: "default",
					scope: undefined,
					summary: "Synced 2 items",
				}),
			}),
		);
		expect(
			window.localStorage.getItem(
				lastSyncStorageKey("mentions" as never, undefined, undefined),
			),
		).not.toBeNull();

		window.removeEventListener("birdclaw:auto-sync-started", started);
		window.removeEventListener("birdclaw:auto-sync-completed", completed);
	});

	it("invalidates the shared timeline/status caches on success, even with no listener mounted", async () => {
		// This is the case that matters: the user navigated away from Home
		// before the sync completed, so no SyncNowButton was around to call
		// its onSynced callback. The driver must refresh the shared caches
		// itself so Home shows fresh data whenever the user comes back.
		enableAutoSync("timeline", undefined, "for_you");
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			if (url.endsWith("/api/sync")) {
				return syncJobResponse("timeline", true, "Synced 3 items");
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { queryClient } = renderWithAccounts();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		await flushInitialCheck();

		expect(syncCalls(fetchMock)).toHaveLength(1);
		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.status }),
		);
		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.timelines }),
		);
	});

	it("invalidates the dms cache (not timelines) for dms syncs", async () => {
		enableAutoSync("dms", undefined, undefined);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			if (url.endsWith("/api/sync")) {
				return syncJobResponse("dms", true, "Synced 1 item");
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { queryClient } = renderWithAccounts();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		await flushInitialCheck();

		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.dms }),
		);
		expect(invalidateSpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: queryKeys.timelines }),
		);
	});

	it("tracks Home's For You and Following feed scopes independently", async () => {
		enableAutoSync("timeline", undefined, "following");
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
				if (url.endsWith("/api/sync")) {
					const body = JSON.parse(String(init?.body));
					return syncJobResponse(body.kind, true, "ok");
				}
				throw new Error(`Unexpected fetch ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		renderWithAccounts();
		await flushInitialCheck();

		const calls = syncCalls(fetchMock);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
			kind: "timeline",
			feed: "following",
		});

		// for_you is a separately-keyed scope and was never enabled, so it must
		// not have been synced even though the "following" scope was due.
		expect(
			window.localStorage.getItem(
				lastSyncStorageKey("timeline" as never, undefined, "for_you"),
			),
		).toBeNull();
	});

	it("only checks dms once under the default suffix, not per real account", async () => {
		enableAutoSync("dms", undefined, undefined);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			if (url.endsWith("/api/sync")) {
				return syncJobResponse("dms", true, "ok");
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		renderWithAccounts([
			{ id: "acct_primary", isDefault: 1 },
			{ id: "acct_studio", isDefault: 0 },
		]);
		await flushInitialCheck();

		const calls = syncCalls(fetchMock);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ kind: "dms" });
	});

	it("skips For You auto sync for a non-default account", async () => {
		enableAutoSync("timeline", "acct_studio", "for_you");
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		renderWithAccounts([
			{ id: "acct_primary", isDefault: 1 },
			{ id: "acct_studio", isDefault: 0 },
		]);
		await flushInitialCheck();

		expect(syncCalls(fetchMock)).toHaveLength(0);
	});

	it("does not fire again while a sync for the same key is still in flight", async () => {
		enableAutoSync("mentions", undefined, undefined);
		let resolveSync: ((response: Response) => void) | undefined;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			if (url.endsWith("/api/sync")) {
				return new Promise<Response>((resolve) => {
					resolveSync = resolve;
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		renderWithAccounts();
		await flushInitialCheck();
		expect(syncCalls(fetchMock)).toHaveLength(1);

		// Next poll tick fires while the first request is still pending.
		await act(async () => vi.advanceTimersByTimeAsync(10_000));
		expect(syncCalls(fetchMock)).toHaveLength(1);

		await act(async () => {
			resolveSync?.(syncJobResponse("mentions", true, "ok"));
			await Promise.resolve();
		});
	});

	it("backs off after a failure and dispatches the failed event", async () => {
		enableAutoSync("mentions", undefined, undefined, 5 * 60_000);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			if (url.endsWith("/api/sync")) {
				return syncJobResponse("mentions", false, "Rate limited");
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const failed = vi.fn();
		window.addEventListener("birdclaw:auto-sync-failed", failed);

		renderWithAccounts();
		await flushInitialCheck();
		expect(failed).toHaveBeenCalledTimes(1);
		expect(failed).toHaveBeenCalledWith(
			expect.objectContaining({
				detail: expect.objectContaining({
					kind: "mentions",
					error: "Rate limited",
				}),
			}),
		);
		expect(syncCalls(fetchMock)).toHaveLength(1);

		// Backoff doubles the interval after one failure: 10s poll ticks land
		// well before the 10-minute backoff window elapses.
		await act(async () => vi.advanceTimersByTimeAsync(9 * 60_000));
		expect(syncCalls(fetchMock)).toHaveLength(1);

		await act(async () => vi.advanceTimersByTimeAsync(2 * 60_000));
		expect(syncCalls(fetchMock)).toHaveLength(2);

		window.removeEventListener("birdclaw:auto-sync-failed", failed);
	});

	it("skips checks while the document is hidden", async () => {
		enableAutoSync("mentions", undefined, undefined);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return Response.json(statusEnvelope());
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		renderWithAccounts();
		await flushInitialCheck();
		await act(async () => vi.advanceTimersByTimeAsync(10_000));

		expect(syncCalls(fetchMock)).toHaveLength(0);
	});
});
