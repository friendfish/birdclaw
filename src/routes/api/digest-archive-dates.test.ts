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
	it.each(["today", "24h", "yesterday", "week"] as const)(
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
});
