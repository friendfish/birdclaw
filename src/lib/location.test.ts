import { describe, expect, it } from "vitest";
import { isMeaningfulLocation, normalizeLocationKey } from "./location";

describe("location normalization", () => {
	it("normalizes usable profile locations", () => {
		expect(normalizeLocationKey("Vienna, Austria")).toBe("vienna,austria");
		expect(normalizeLocationKey("San Francisco / London")).toBe(
			"san francisco,london",
		);
		expect(normalizeLocationKey("48.2082, 16.3738")).toBe(
			"coords:48.2082,16.3738",
		);
	});

	it("drops obvious non-locations", () => {
		expect(isMeaningfulLocation("everywhere")).toBe(false);
		expect(isMeaningfulLocation("https://example.com")).toBe(false);
		expect(isMeaningfulLocation("right behind you")).toBe(false);
		expect(isMeaningfulLocation("$5,000")).toBe(false);
		expect(normalizeLocationKey("followers 10, 20")).not.toMatch(/^coords:/);
	});
});
