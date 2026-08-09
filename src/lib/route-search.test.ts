import { describe, expect, it } from "vitest";
import {
	validateBlocksSearch,
	validateDiscussSearch,
	validateDmsSearch,
	validateInboxSearch,
	validateLinksSearch,
	validateNetworkMapSearch,
	validateTodaySearch,
} from "./route-search";

describe("route search schemas", () => {
	it("applies defaults and rejects invalid enum values", () => {
		expect(
			validateDmsSearch({ inbox: "invalid", reply: "replied" }),
		).toMatchObject({
			inbox: "all",
			reply: "replied",
			sort: "recent",
		});
		expect(
			validateLinksSearch({ range: "forever", kind: "videos" }),
		).toMatchObject({
			kind: "videos",
			range: "week",
		});
		expect(validateDiscussSearch({ mode: "bad" }).mode).toBe("");
		expect(validateDiscussSearch({}).mode).toBe("");
		for (const mode of ["auto", "bird", "xurl", "local"] as const) {
			expect(validateDiscussSearch({ mode }).mode).toBe(mode);
		}
		expect(validateTodaySearch({ period: "bad" }).period).toBe("today");
		expect(validateTodaySearch({ contentSource: "bad" }).contentSource).toBe(
			"all",
		);
		expect(
			validateTodaySearch({ contentSource: "following" }).contentSource,
		).toBe("following");
		expect(validateNetworkMapSearch({ type: "bad" }).type).toBe("all");
	});

	it("only accepts real archiveDate values, otherwise falling back to empty", () => {
		expect(validateTodaySearch({}).archiveDate).toBe("");
		expect(validateTodaySearch({ archiveDate: "2026-07-21" }).archiveDate).toBe(
			"2026-07-21",
		);
		expect(validateTodaySearch({ archiveDate: "2000-02-29" }).archiveDate).toBe(
			"2000-02-29",
		);
		expect(validateTodaySearch({ archiveDate: "2026-02-30" }).archiveDate).toBe(
			"",
		);
		expect(validateTodaySearch({ archiveDate: "1900-02-29" }).archiveDate).toBe(
			"",
		);
		expect(validateTodaySearch({ archiveDate: "not-a-date" }).archiveDate).toBe(
			"",
		);
		expect(validateTodaySearch({ archiveDate: "2026-7-1" }).archiveDate).toBe(
			"",
		);
		expect(validateTodaySearch({ archiveDate: 123 }).archiveDate).toBe("");
	});

	it("normalizes booleans and string filters", () => {
		expect(validateInboxSearch({ hideLowSignal: "0", minScore: "70" })).toEqual(
			{
				kind: "mixed",
				minScore: "70",
				hideLowSignal: false,
			},
		);
		expect(validateTodaySearch({ includeDms: "1" }).includeDms).toBe(true);
		expect(validateBlocksSearch({ account: 3, q: "sam" })).toEqual({
			account: "acct_primary",
			q: "sam",
		});
	});
});
