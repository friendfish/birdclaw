// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const resolveDigestArchiveDirMock = vi.fn();
const listDigestArchiveDatesEffectMock = vi.fn();

vi.mock("#/lib/config", () => ({
	resolveDigestArchiveDir: (...args: unknown[]) =>
		resolveDigestArchiveDirMock(...args),
}));
vi.mock("#/lib/digest-archive-job", () => ({
	listDigestArchiveDatesEffect: (...args: unknown[]) =>
		Effect.promise(() => listDigestArchiveDatesEffectMock(...args)),
}));

import { Route } from "./digest-archive-dates";

const GET = getRouteHandler(Route, "GET");

describe("api digest-archive-dates route", () => {
	it("defaults to yesterday and forwards the resolved archive dir", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		listDigestArchiveDatesEffectMock.mockResolvedValue([
			{ date: "2026-07-21", contentSources: ["all"] },
		]);

		const response = await GET({
			request: new Request("http://localhost/api/digest-archive-dates"),
		});

		expect(listDigestArchiveDatesEffectMock).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			period: "yesterday",
		});
		expect(await response.json()).toEqual({
			ok: true,
			dates: [{ date: "2026-07-21", contentSources: ["all"] }],
		});
	});

	it("accepts an explicit week period", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		listDigestArchiveDatesEffectMock.mockResolvedValue([]);

		await GET({
			request: new Request(
				"http://localhost/api/digest-archive-dates?period=week",
			),
		});

		expect(listDigestArchiveDatesEffectMock).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			period: "week",
		});
	});

	it("falls back to yesterday for an unrecognized period", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		listDigestArchiveDatesEffectMock.mockResolvedValue([]);

		await GET({
			request: new Request(
				"http://localhost/api/digest-archive-dates?period=today",
			),
		});

		expect(listDigestArchiveDatesEffectMock).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			period: "yesterday",
		});
	});
});
