// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { upsertTweetFeedEdge } from "./tweet-feed-edges";

const tempDirs: string[] = [];

function makeTempHome() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-feed-edge-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("tweet feed edges", () => {
	it("records a feed membership row once per tweet/feed pair", () => {
		makeTempHome();
		const db = getNativeDb();

		upsertTweetFeedEdge(db, {
			tweetId: "T1",
			feed: "following",
			seenAt: "2026-05-10T12:00:00.000Z",
		});
		upsertTweetFeedEdge(db, {
			tweetId: "T1",
			feed: "following",
			seenAt: "2026-05-11T12:00:00.000Z",
		});

		expect(
			db
				.prepare(
					"select tweet_id, feed, first_seen_at from tweet_feed_edges where tweet_id = ?",
				)
				.all("T1"),
		).toEqual([
			{
				tweet_id: "T1",
				feed: "following",
				first_seen_at: "2026-05-10T12:00:00.000Z",
			},
		]);
	});

	it("allows a tweet to belong to both feeds as two separate rows", () => {
		makeTempHome();
		const db = getNativeDb();

		upsertTweetFeedEdge(db, {
			tweetId: "T1",
			feed: "following",
			seenAt: "2026-05-10T12:00:00.000Z",
		});
		upsertTweetFeedEdge(db, {
			tweetId: "T1",
			feed: "for_you",
			seenAt: "2026-05-10T12:00:00.000Z",
		});

		expect(
			db
				.prepare(
					"select feed from tweet_feed_edges where tweet_id = ? order by feed",
				)
				.all("T1"),
		).toEqual([{ feed: "following" }, { feed: "for_you" }]);
	});
});
