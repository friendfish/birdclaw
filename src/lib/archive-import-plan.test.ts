import { describe, expect, it } from "vitest";
import { ArchiveImportPlan, type ArchiveTweetRow } from "./archive-import-plan";

function tweet(overrides: Partial<ArchiveTweetRow> = {}): ArchiveTweetRow {
	return {
		id: "tweet-1",
		kind: "home",
		authorProfileId: "profile-me",
		text: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		isReplied: 0,
		replyToId: null,
		likeCount: 0,
		mediaCount: 0,
		bookmarked: 0,
		liked: 0,
		entitiesJson: "{}",
		mediaJson: "[]",
		quotedTweetId: null,
		...overrides,
	};
}

describe("ArchiveImportPlan", () => {
	it("merges duplicate tweet collection flags and fills missing text", () => {
		const plan = new ArchiveImportPlan();

		plan.addTweet(tweet({ bookmarked: 1 }));
		plan.addTweet(tweet({ text: "restored", liked: 1 }));

		expect(plan.tweets).toEqual([
			expect.objectContaining({
				id: "tweet-1",
				text: "restored",
				bookmarked: 1,
				liked: 1,
			}),
		]);
		expect(plan.getTweet("tweet-1")).toBe(plan.tweets[0]);
	});

	it("preserves existing non-empty tweet text", () => {
		const plan = new ArchiveImportPlan();

		plan.addTweet(tweet({ text: "original" }));
		plan.addTweet(tweet({ text: "replacement", liked: 1 }));

		expect(plan.tweets[0]?.text).toBe("original");
		expect(plan.tweets[0]?.liked).toBe(1);
	});
});
