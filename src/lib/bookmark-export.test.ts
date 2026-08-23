// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import {
	parseBookmarkArchiveFile,
	scanBookmarkArchive,
} from "./bookmark-markdown-archive";
import { exportBookmarks } from "./bookmark-export";
import type { Database } from "./sqlite";

const USER_NOTES_START = "<!-- birdclaw:user-notes:start -->";
const USER_NOTES_END = "<!-- birdclaw:user-notes:end -->";
const getHome = useTestHome({ seedDemoData: false });

function insertBookmarkCollection(
	db: Database,
	options: {
		accountId?: string;
		tweetId: string;
		collectedAt?: string | null;
		updatedAt?: string;
	},
) {
	db.prepare(
		`insert into tweet_collections (
			account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
		) values (?, ?, 'bookmarks', ?, 'archive', '{}', ?)`,
	).run(
		options.accountId ?? "account:primary",
		options.tweetId,
		options.collectedAt === undefined
			? "2026-08-24T01:00:00.000Z"
			: options.collectedAt,
		options.updatedAt ?? "2026-08-24T02:00:00.000Z",
	);
}

function seedDefaultAccount() {
	const home = getHome();
	insertTestAccount(home.db, {
		id: "account:primary",
		handle: "@primary",
	});
	insertTestProfile(home.db, {
		id: "profile:author",
		handle: "author",
		displayName: "Author Name",
	});
	return home;
}

function archivePath(
	archiveDir: string,
	accountId: string,
	year: string,
	month: string,
	tweetId: string,
) {
	return path.join(
		archiveDir,
		"accounts",
		encodeURIComponent(accountId),
		year,
		month,
		`${encodeURIComponent(tweetId)}.md`,
	);
}

describe("bookmark export", () => {
	it("exports incrementally and retains files no longer present in bookmarks", async () => {
		const home = seedDefaultAccount();
		insertTestTweet(home.db, {
			id: "tweet:newer",
			authorProfileId: "profile:author",
			text: "Newest saved item",
			createdAt: "2026-08-23T12:00:00.000Z",
		});
		insertTestTweet(home.db, {
			id: "tweet:older",
			authorProfileId: "profile:author",
			text: "Older saved item",
			createdAt: "2026-07-01T12:00:00.000Z",
		});
		insertBookmarkCollection(home.db, { tweetId: "tweet:newer" });
		insertBookmarkCollection(home.db, { tweetId: "tweet:older" });
		const archiveDir = home.makeTempDir("birdclaw-bookmarks-");
		const now = () => new Date("2026-08-24T03:00:00.000Z");

		const first = await exportBookmarks({ archiveDir, db: home.db, now });

		expect(first).toMatchObject({
			ok: true,
			accountId: "account:primary",
			mode: "incremental",
			created: 2,
			updated: 0,
			unchanged: 0,
			conflicted: 0,
			indexEntries: 2,
		});
		home.db
			.prepare(
				"delete from tweet_collections where account_id = ? and tweet_id = ? and kind = 'bookmarks'",
			)
			.run("account:primary", "tweet:older");

		const second = await exportBookmarks({ archiveDir, db: home.db, now });

		expect(second).toMatchObject({
			ok: true,
			created: 0,
			updated: 0,
			unchanged: 1,
			conflicted: 0,
			indexEntries: 2,
		});
		await expect(
			fs.readFile(
				archivePath(archiveDir, "account:primary", "2026", "07", "tweet:older"),
				"utf8",
			),
		).resolves.toContain("Older saved item");
		await expect(
			fs.readFile(path.join(archiveDir, "INDEX.md"), "utf8"),
		).resolves.toContain("- Total archived: 2");
	});

	it("updates managed content and preserves exact user notes", async () => {
		const home = seedDefaultAccount();
		insertTestTweet(home.db, {
			id: "tweet:notes",
			authorProfileId: "profile:author",
			text: "Original text",
			createdAt: "2026-08-23T12:00:00.000Z",
		});
		insertBookmarkCollection(home.db, { tweetId: "tweet:notes" });
		const archiveDir = home.makeTempDir("birdclaw-bookmarks-");
		const now = () => new Date("2026-08-24T03:00:00.000Z");
		await exportBookmarks({ archiveDir, db: home.db, now });
		const filePath = archivePath(
			archiveDir,
			"account:primary",
			"2026",
			"08",
			"tweet:notes",
		);
		const notes = "\n第一遍精读。  \n\n- [ ] 验证结论\n";
		const withNotes = (await fs.readFile(filePath, "utf8")).replace(
			`${USER_NOTES_START}\n\n${USER_NOTES_END}`,
			`${USER_NOTES_START}${notes}${USER_NOTES_END}`,
		);
		await fs.writeFile(filePath, withNotes, "utf8");
		home.db
			.prepare("update tweets set text = ? where id = ?")
			.run("Updated text", "tweet:notes");
		home.db
			.prepare(
				"update tweet_collections set updated_at = ? where account_id = ? and tweet_id = ? and kind = 'bookmarks'",
			)
			.run("2026-08-24T04:00:00.000Z", "account:primary", "tweet:notes");

		const incremental = await exportBookmarks({ archiveDir, db: home.db, now });
		const updated = await fs.readFile(filePath, "utf8");

		expect(incremental).toMatchObject({ updated: 1, unchanged: 0 });
		expect(updated).toContain("Updated text");
		expect(parseBookmarkArchiveFile(updated).userNotes).toBe(notes);

		const full = await exportBookmarks({
			archiveDir,
			db: home.db,
			full: true,
			now,
		});
		expect(full).toMatchObject({ mode: "full", updated: 1, unchanged: 0 });
		expect(
			parseBookmarkArchiveFile(await fs.readFile(filePath, "utf8")).userNotes,
		).toBe(notes);
	});

	it("leaves malformed user-note regions untouched and reports a conflict", async () => {
		const home = seedDefaultAccount();
		insertTestTweet(home.db, {
			id: "tweet:conflict",
			authorProfileId: "profile:author",
			text: "Original text",
			createdAt: "2026-08-23T12:00:00.000Z",
		});
		insertBookmarkCollection(home.db, { tweetId: "tweet:conflict" });
		const archiveDir = home.makeTempDir("birdclaw-bookmarks-");
		const now = () => new Date("2026-08-24T03:00:00.000Z");
		await exportBookmarks({ archiveDir, db: home.db, now });
		const filePath = archivePath(
			archiveDir,
			"account:primary",
			"2026",
			"08",
			"tweet:conflict",
		);
		const malformed = (await fs.readFile(filePath, "utf8")).replace(
			USER_NOTES_END,
			"",
		);
		await fs.writeFile(filePath, malformed, "utf8");
		home.db
			.prepare("update tweets set text = ? where id = ?")
			.run("Changed upstream", "tweet:conflict");

		const result = await exportBookmarks({ archiveDir, db: home.db, now });

		expect(result).toMatchObject({
			ok: false,
			created: 0,
			updated: 0,
			unchanged: 0,
			conflicted: 1,
			indexEntries: 0,
		});
		expect(result.errors).toHaveLength(1);
		await expect(fs.readFile(filePath, "utf8")).resolves.toBe(malformed);
		await expect(
			fs.readFile(path.join(archiveDir, "INDEX.md"), "utf8"),
		).resolves.toContain("## Unindexed files");
	});

	it("isolates the same bookmark by account and preserves a null collected time", async () => {
		const home = getHome();
		insertTestAccount(home.db, {
			id: "account:primary",
			handle: "@primary",
			isDefault: 1,
		});
		insertTestAccount(home.db, {
			id: "account:secondary",
			handle: "@secondary",
			isDefault: 0,
		});
		insertTestProfile(home.db, {
			id: "profile:author",
			handle: "author",
			displayName: "Author Name",
		});
		insertTestTweet(home.db, {
			id: "tweet:shared",
			authorProfileId: "profile:author",
			text: "Shared tweet",
			createdAt: "2026-08-23T12:00:00.000Z",
		});
		insertBookmarkCollection(home.db, {
			accountId: "account:primary",
			tweetId: "tweet:shared",
			collectedAt: null,
		});
		insertBookmarkCollection(home.db, {
			accountId: "account:secondary",
			tweetId: "tweet:shared",
		});
		const archiveDir = home.makeTempDir("birdclaw-bookmarks-");
		const now = () => new Date("2026-08-24T03:00:00.000Z");

		const primary = await exportBookmarks({
			account: "primary",
			archiveDir,
			db: home.db,
			now,
		});
		const secondary = await exportBookmarks({
			account: "account:secondary",
			archiveDir,
			db: home.db,
			now,
		});
		const scan = await scanBookmarkArchive(archiveDir);

		expect(primary).toMatchObject({
			ok: true,
			accountId: "account:primary",
			created: 1,
			indexEntries: 1,
		});
		expect(secondary).toMatchObject({
			ok: true,
			accountId: "account:secondary",
			created: 1,
			indexEntries: 2,
		});
		expect(
			scan.entries.map((entry) => entry.metadata.accountId).sort(),
		).toEqual(["account:primary", "account:secondary"]);
		expect(
			scan.entries.find(
				(entry) => entry.metadata.accountId === "account:primary",
			)?.metadata.bookmarkedAt,
		).toBeNull();
	});

	it("shares the scheduled lock and skips a concurrent manual export", async () => {
		const home = seedDefaultAccount();
		insertTestTweet(home.db, {
			id: "tweet:locked",
			authorProfileId: "profile:author",
			text: "Do not write while another export owns the lock",
			createdAt: "2026-08-23T12:00:00.000Z",
		});
		insertBookmarkCollection(home.db, { tweetId: "tweet:locked" });
		const archiveDir = home.makeTempDir("birdclaw-bookmarks-");
		const lockPath = path.join(home.root, "locks", "bookmark-export.lock");
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, "{}\n", "utf8");

		const result = await exportBookmarks({
			archiveDir,
			db: home.db,
			lockPath,
			now: () => new Date("2026-08-24T03:00:00.000Z"),
		});

		expect(result).toMatchObject({
			ok: true,
			skipped: "already-running",
			created: 0,
			updated: 0,
			unchanged: 0,
			conflicted: 0,
			indexEntries: 0,
		});
		await expect(
			fs.stat(path.join(archiveDir, "accounts")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
