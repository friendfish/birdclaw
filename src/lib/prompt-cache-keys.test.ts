// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	__test__ as periodDigestTest,
	periodDigestGenerationKey,
	type PeriodDigestContext,
	type PeriodDigestOptions,
} from "./period-digest";
import {
	__test__ as profileAnalysisTest,
	type ProfileAnalysisContext,
	type ProfileAnalysisOptions,
} from "./profile-analysis";
import {
	__test__ as searchDiscussionTest,
	type SearchDiscussionContext,
	type SearchDiscussionOptions,
} from "./search-discussion";

const modelOptions = {
	model: "test-model",
	reasoningEffort: "low" as const,
	serviceTier: "flex" as const,
};

describe("prompt-aware cache keys", () => {
	it("changes every result cache key while leaving generation identity stable", () => {
		const periodContext = { hash: "period-context" } as PeriodDigestContext;
		const periodOptions: PeriodDigestOptions = {
			period: "today",
			language: "en",
			...modelOptions,
		};
		expect(
			periodDigestTest.digestCacheKey(periodContext, periodOptions, "prompt-a"),
		).not.toBe(
			periodDigestTest.digestCacheKey(periodContext, periodOptions, "prompt-b"),
		);
		expect(
			periodDigestTest.latestDigestCacheKey(periodOptions, "prompt-a"),
		).not.toBe(
			periodDigestTest.latestDigestCacheKey(periodOptions, "prompt-b"),
		);

		const profileContext = {
			hash: "profile-context",
		} as ProfileAnalysisContext;
		const profileOptions: ProfileAnalysisOptions = {
			handle: "alice",
			language: "en",
			...modelOptions,
		};
		expect(
			profileAnalysisTest.resultCacheKey(
				profileContext,
				profileOptions,
				"prompt-a",
			),
		).not.toBe(
			profileAnalysisTest.resultCacheKey(
				profileContext,
				profileOptions,
				"prompt-b",
			),
		);

		const searchContext = { hash: "search-context" } as SearchDiscussionContext;
		const searchOptions: SearchDiscussionOptions = {
			query: "local-first",
			...modelOptions,
		};
		expect(
			searchDiscussionTest.cacheKey(searchContext, searchOptions, "prompt-a"),
		).not.toBe(
			searchDiscussionTest.cacheKey(searchContext, searchOptions, "prompt-b"),
		);

		const generationKey = periodDigestGenerationKey(periodOptions);
		expect(generationKey).not.toContain("prompt-a");
		expect(generationKey).not.toContain("prompt-b");
	});

	it("keeps the profile context hash as the final cache-key segment", () => {
		const key = profileAnalysisTest.resultCacheKey(
			{ hash: "final-context-hash" } as ProfileAnalysisContext,
			{ handle: "alice", language: "en", ...modelOptions },
			"prompt-hash",
		);
		expect(key.split(":").at(-1)).toBe("final-context-hash");
		expect(key).toContain("profile-analysis:result:prompt-hash:");
	});
});
