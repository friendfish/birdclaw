// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

let homeDir = "";

function insertAccountFixture() {
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(`
    insert into accounts (
      id, name, handle, external_user_id, transport, is_default, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
		"acct_primary",
		"Peter",
		"steipete",
		"25401953",
		"bird",
		1,
		"2026-04-01T00:00:00.000Z",
	);
	db.prepare(`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      avatar_hue, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		"profile_me",
		"steipete",
		"Peter Steinberger",
		"",
		1,
		0,
		1,
		"2026-04-01T00:00:00.000Z",
	);
	db.prepare(`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      avatar_hue, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		"profile_fernando",
		"fernandorojo",
		"Fernando Rojo",
		"",
		1,
		0,
		2,
		"2026-04-01T00:00:00.000Z",
	);
	db.prepare(`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      avatar_hue, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		"profile_codetaur",
		"codetaur",
		"Codetard",
		"",
		1,
		0,
		3,
		"2026-04-01T00:00:00.000Z",
	);
	return db;
}

describe("link index", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-link-index-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("finds a DM t.co share through the expanded linked tweet", async () => {
		const db = insertAccountFixture();
		db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at, is_replied,
        reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"2039395915421942108",
			"acct_primary",
			"profile_codetaur",
			"bookmark",
			"asking a vibecoder in the throes of AI psychosis what their 100k lines of code do https://t.co/veTztOtK8Q",
			"2026-04-01T17:34:11.000Z",
			0,
			null,
			4478,
			1,
			1,
			1,
			"{}",
			JSON.stringify([
				{ type: "video", url: "https://pbs.twimg.com/video.jpg" },
			]),
			null,
		);
		db.prepare(`
      insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at,
        unread_count, needs_reply
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
			"dm_fernando",
			"acct_primary",
			"profile_fernando",
			"Fernando Rojo",
			"2026-04-02T02:52:36.464Z",
			0,
			0,
		);
		db.prepare(`
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction,
        is_replied, media_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"dm_msg_1",
			"dm_fernando",
			"profile_me",
			"https://t.co/WuQhCIi5r3",
			"2026-04-02T02:52:36.464Z",
			"outbound",
			0,
			0,
		);

		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://x.com/codetaur/status/2039395915421942108",
		} as Response);
		const { backfillLinkIndex, searchLinks } = await import("./link-index");

		await expect(backfillLinkIndex({ fetchImpl })).resolves.toMatchObject({
			occurrences: 2,
			uniqueUrls: 2,
			networkExpansions: 2,
			remainingUnexpanded: 0,
		});
		expect(
			searchLinks("vibecoder", {
				direction: "outbound",
				mediaType: "video",
				since: "2026-04-01",
				until: "2026-04-03",
			}),
		).toEqual([
			expect.objectContaining({
				occurrence: expect.objectContaining({
					sourceKind: "dm",
					shortUrl: "https://t.co/WuQhCIi5r3",
				}),
				participant: expect.objectContaining({ handle: "fernandorojo" }),
				linkedTweet: expect.objectContaining({
					id: "2039395915421942108",
					text: expect.stringContaining("vibecoder"),
				}),
			}),
		]);
	});

	it("seeds tweet entity expansions without a network call", async () => {
		const db = insertAccountFixture();
		db.prepare(`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at, is_replied,
        reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"tweet_1",
			"acct_primary",
			"profile_me",
			"home",
			"read https://t.co/entity",
			"2026-04-01T12:00:00.000Z",
			0,
			null,
			1,
			0,
			0,
			0,
			JSON.stringify({
				urls: [
					{
						url: "https://t.co/entity",
						expandedUrl: "https://example.com/vibecoder-note",
						displayUrl: "example.com/vibecoder-note",
					},
				],
			}),
			"[]",
			null,
		);
		const fetchImpl = vi.fn();
		const { backfillLinkIndex, searchLinks } = await import("./link-index");

		await expect(backfillLinkIndex({ fetchImpl })).resolves.toMatchObject({
			occurrences: 1,
			uniqueUrls: 1,
			entityExpansions: 1,
			networkExpansions: 0,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(searchLinks("vibecoder")).toHaveLength(1);
	});

	it("retries failed expansion rows on normal backfills", async () => {
		const db = insertAccountFixture();
		db.prepare(`
      insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at,
        unread_count, needs_reply
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
			"dm_fernando",
			"acct_primary",
			"profile_fernando",
			"Fernando Rojo",
			"2026-04-02T02:52:36.464Z",
			0,
			0,
		);
		db.prepare(`
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction,
        is_replied, media_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"dm_msg_1",
			"dm_fernando",
			"profile_me",
			"https://t.co/retry",
			"2026-04-02T02:52:36.464Z",
			"outbound",
			0,
			0,
		);
		db.prepare(`
      insert into url_expansions (
        short_url, expanded_url, final_url, status, expanded_tweet_id,
        expanded_handle, title, description, error, source, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			"https://t.co/retry",
			"https://t.co/retry",
			"https://t.co/retry",
			"error",
			null,
			null,
			null,
			null,
			"network timeout",
			"network",
			"2026-04-02T02:52:36.464Z",
		);
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://x.com/codetaur/status/2039395915421942108",
		} as Response);
		const { backfillLinkIndex } = await import("./link-index");

		await expect(
			backfillLinkIndex({ fetchImpl, source: "dm" }),
		).resolves.toMatchObject({
			networkExpansions: 1,
			remainingUnexpanded: 0,
		});
		expect(
			db
				.prepare(
					"select status, expanded_tweet_id from url_expansions where short_url = ?",
				)
				.get("https://t.co/retry"),
		).toEqual({
			status: "hit",
			expanded_tweet_id: "2039395915421942108",
		});
	});
});
