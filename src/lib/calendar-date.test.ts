import { describe, expect, it } from "vitest";
import { isCalendarDateString } from "./calendar-date";

describe("calendar date strings", () => {
	it.each(["0001-01-01", "2000-02-29", "2026-07-21", "9999-12-31"])(
		"accepts the real YYYY-MM-DD date %s",
		(value) => {
			expect(isCalendarDateString(value)).toBe(true);
		},
	);

	it.each([
		null,
		undefined,
		"",
		"0000-01-01",
		"1900-02-29",
		"2026-02-30",
		"2026-7-21",
		"２０２６-０７-２１",
	])("rejects the non-real calendar date %s", (value) => {
		expect(isCalendarDateString(value)).toBe(false);
	});
});
