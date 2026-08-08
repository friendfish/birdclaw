// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each(["yesterday", "week"] as const)(
		"lists %s archives without changing the period",
		async (period) => {
			resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
			listDigestArchiveDatesEffectMock.mockResolvedValue([]);

			const response = await GET({
				request: new Request(
					`http://localhost/api/digest-archive-dates?period=${period}`,
				),
			});

			expect(listDigestArchiveDatesEffectMock).toHaveBeenCalledWith({
				archiveDir: "/tmp/archive",
				period,
			});
			expect(await response.json()).toEqual({ ok: true, dates: [] });
		},
	);

	it("defaults an omitted period to yesterday", async () => {
		resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
		listDigestArchiveDatesEffectMock.mockResolvedValue([]);

		const response = await GET({
			request: new Request("http://localhost/api/digest-archive-dates"),
		});

		expect(response.status).toBe(200);
		expect(listDigestArchiveDatesEffectMock).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			period: "yesterday",
		});
	});

	it("rejects an invalid period before reading legacy archives", async () => {
		const response = await GET({
			request: new Request(
				"http://localhost/api/digest-archive-dates?period=month",
			),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Archive period must be yesterday or week.",
		});
		expect(resolveDigestArchiveDirMock).not.toHaveBeenCalled();
		expect(listDigestArchiveDatesEffectMock).not.toHaveBeenCalled();
	});

	it.each(["today", "24h"] as const)(
		"rejects the current-view period %s without reading legacy archives",
		async (period) => {
			const response = await GET({
				request: new Request(
					`http://localhost/api/digest-archive-dates?period=${period}`,
				),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				ok: false,
				error: "Today and 24h are current views and do not have archives.",
			});
			expect(listDigestArchiveDatesEffectMock).not.toHaveBeenCalled();
		},
	);
});
