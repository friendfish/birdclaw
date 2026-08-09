import { describe, expect, it } from "vitest";
import {
	DigestArchiveRequestError,
	parseDigestArchiveContentSource,
	parseDigestArchiveDate,
	parseDigestArchivePeriod,
} from "./digest-archive-request";

function captureError(run: () => unknown) {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("Expected function to throw");
}

describe("digest archive request validation", () => {
	it("preserves omitted defaults and accepts every archive value", () => {
		expect(parseDigestArchivePeriod(null)).toBe("yesterday");
		expect(parseDigestArchivePeriod("week")).toBe("week");
		expect(parseDigestArchiveContentSource(null)).toBe("all");
		expect(parseDigestArchiveContentSource("following")).toBe("following");
		expect(parseDigestArchiveContentSource("for_you")).toBe("for_you");
	});

	it.each(["0001-01-01", "2000-02-29", "9999-12-31"])(
		"accepts the real boundary date %s",
		(value) => {
			expect(parseDigestArchiveDate(value)).toBe(value);
		},
	);

	it.each(["0000-01-01", "1900-02-29", "9999-02-29"])(
		"rejects the non-real boundary date %s",
		(value) => {
			expect(() => parseDigestArchiveDate(value)).toThrow(
				"Archive date must be a real date in YYYY-MM-DD format.",
			);
		},
	);

	it.each([
		[
			() => parseDigestArchivePeriod(""),
			"Archive period must be yesterday or week.",
		],
		[
			() => parseDigestArchiveContentSource(""),
			"Archive contentSource must be all, following, or for_you.",
		],
		[
			() => parseDigestArchiveDate(""),
			"Archive date must be a real date in YYYY-MM-DD format.",
		],
	] as const)(
		"throws a dedicated request error for an explicit empty value",
		(run, message) => {
			const error = captureError(run);

			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(DigestArchiveRequestError);
			expect((error as Error).constructor.name).toBe(
				"DigestArchiveRequestError",
			);
			expect((error as Error).message).toBe(message);
		},
	);

	it.each(["today", "24h"])(
		"preserves the current-view message for %s",
		(value) => {
			expect(() => parseDigestArchivePeriod(value)).toThrow(
				"Today and 24h are current views and do not have archives.",
			);
		},
	);
});
