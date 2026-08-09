// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const resolveDigestArchiveDirMock = vi.fn();
const readDigestArchiveEntryEffectMock = vi.fn();

vi.mock("#/lib/config", () => ({
	resolveDigestArchiveDir: (...args: unknown[]) =>
		resolveDigestArchiveDirMock(...args),
}));
vi.mock("#/lib/digest-archive-job", () => ({
	readDigestArchiveEntryEffect: (...args: unknown[]) =>
		Effect.promise(() => readDigestArchiveEntryEffectMock(...args)),
}));

import { Route } from "./digest-archive-entry";

const GET = getRouteHandler(Route, "GET");

describe("api digest-archive-entry route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("adapts a found archive entry into the run-result shape, using generatedAt as updatedAt", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		readDigestArchiveEntryEffectMock.mockResolvedValue({
			schemaVersion: 1,
			period: "yesterday",
			contentSource: "all",
			runDate: "2026-07-21",
			generatedAt: "2026-07-21T01:00:00.000Z",
			context: { tweets: [] },
			digest: { title: "T" },
			markdown: "# Hello",
			model: "gpt-5.5",
			reasoningEffort: "medium",
			serviceTier: "priority",
			cached: false,
		});

		const response = await GET({
			request: new Request(
				"http://localhost/api/digest-archive-entry?period=yesterday&contentSource=all&date=2026-07-21",
			),
		});

		expect(readDigestArchiveEntryEffectMock).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			period: "yesterday",
			contentSource: "all",
			date: "2026-07-21",
		});
		expect(await response.json()).toEqual({
			ok: true,
			result: {
				context: { tweets: [] },
				digest: { title: "T" },
				markdown: "# Hello",
				model: "gpt-5.5",
				reasoningEffort: "medium",
				serviceTier: "priority",
				cached: false,
				updatedAt: "2026-07-21T01:00:00.000Z",
			},
		});
	});

	it("returns 200 with result: null when no archive matches (not a 404 — fetchJson treats any non-2xx as an error)", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		readDigestArchiveEntryEffectMock.mockResolvedValue(null);

		const response = await GET({
			request: new Request(
				"http://localhost/api/digest-archive-entry?period=week&contentSource=following&date=2026-07-20",
			),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, result: null });
	});

	it("defaults an entry request with only a date to yesterday and all", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		readDigestArchiveEntryEffectMock.mockResolvedValue(null);

		const response = await GET({
			request: new Request(
				"http://localhost/api/digest-archive-entry?date=2024-02-29",
			),
		});

		expect(response.status).toBe(200);
		expect(readDigestArchiveEntryEffectMock).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			period: "yesterday",
			contentSource: "all",
			date: "2024-02-29",
		});
	});

	it.each([
		{
			query: "period=month&contentSource=all&date=2026-07-21",
			error: "Archive period must be yesterday or week.",
		},
		{
			query: "period=yesterday&contentSource=private&date=2026-07-21",
			error: "Archive contentSource must be all, following, or for_you.",
		},
		{
			query: "period=yesterday&contentSource=all",
			error: "Archive date must be a real date in YYYY-MM-DD format.",
		},
		{
			query: "period=yesterday&contentSource=all&date=2026-7-21",
			error: "Archive date must be a real date in YYYY-MM-DD format.",
		},
		{
			query: "period=yesterday&contentSource=all&date=2026-02-30",
			error: "Archive date must be a real date in YYYY-MM-DD format.",
		},
		{
			query: "period=yesterday&contentSource=all&date=0000-01-01",
			error: "Archive date must be a real date in YYYY-MM-DD format.",
		},
		{
			query:
				"period=yesterday&contentSource=all&date=%2E%2E%2F%2E%2E%2Foutside",
			error: "Archive date must be a real date in YYYY-MM-DD format.",
		},
	])(
		"rejects an invalid archive entry request: $query",
		async ({ query, error }) => {
			const response = await GET({
				request: new Request(
					`http://localhost/api/digest-archive-entry?${query}`,
				),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ ok: false, error });
			expect(resolveDigestArchiveDirMock).not.toHaveBeenCalled();
			expect(readDigestArchiveEntryEffectMock).not.toHaveBeenCalled();
		},
	);

	it.each(["today", "24h"] as const)(
		"rejects current-view period %s without reading legacy archives",
		async (period) => {
			const response = await GET({
				request: new Request(
					`http://localhost/api/digest-archive-entry?period=${period}&contentSource=following&date=2026-07-20`,
				),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				ok: false,
				error: "Today and 24h are current views and do not have archives.",
			});
			expect(readDigestArchiveEntryEffectMock).not.toHaveBeenCalled();
		},
	);
});
