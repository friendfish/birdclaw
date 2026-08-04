// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
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

	it("accepts Today and defaults an unrecognized contentSource to all", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		readDigestArchiveEntryEffectMock.mockResolvedValue(null);

		await GET({
			request: new Request(
				"http://localhost/api/digest-archive-entry?period=today&contentSource=bogus&date=2026-07-20",
			),
		});

		expect(readDigestArchiveEntryEffectMock).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			period: "today",
			contentSource: "all",
			date: "2026-07-20",
		});
	});

	it("accepts the 24h period", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		readDigestArchiveEntryEffectMock.mockResolvedValue(null);

		await GET({
			request: new Request(
				"http://localhost/api/digest-archive-entry?period=24h&contentSource=following&date=2026-07-20",
			),
		});

		expect(readDigestArchiveEntryEffectMock).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			period: "24h",
			contentSource: "following",
			date: "2026-07-20",
		});
	});
});
