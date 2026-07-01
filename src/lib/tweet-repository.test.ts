// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { ingestTweetPayload } from "./tweet-repository";

let tempRoot: string | undefined;

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

it("marks only primary replies as replied", () => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-test-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	const db = getNativeDb();

	ingestTweetPayload(db, {
		accountId: "acct_primary",
		markRepliesAsReplied: true,
		source: "xurl",
		payload: {
			data: [
				{
					id: "liked_reply",
					author_id: "42",
					text: "primary reply quoting context",
					created_at: "2026-07-01T10:00:00.000Z",
					referenced_tweets: [
						{ type: "replied_to", id: "primary_parent" },
						{ type: "quoted", id: "quoted_reply" },
					],
				},
			],
			includes: {
				users: [
					{ id: "42", username: "sam", name: "Sam" },
					{ id: "43", username: "alex", name: "Alex" },
				],
				tweets: [
					{
						id: "quoted_reply",
						author_id: "43",
						text: "included reply used only as quote context",
						created_at: "2026-07-01T09:00:00.000Z",
						referenced_tweets: [{ type: "replied_to", id: "quoted_parent" }],
					},
				],
			},
		},
	});

	expect(
		db
			.prepare(
				"select id, is_replied, reply_to_id from tweets where id in (?, ?) order by id",
			)
			.all("liked_reply", "quoted_reply"),
	).toEqual([
		{ id: "liked_reply", is_replied: 1, reply_to_id: "primary_parent" },
		{ id: "quoted_reply", is_replied: 0, reply_to_id: "quoted_parent" },
	]);
});
