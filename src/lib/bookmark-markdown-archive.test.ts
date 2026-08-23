// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildBookmarkArchiveIndex,
	parseBookmarkArchiveFile,
	renderBookmarkArchiveFile,
	resolveBookmarkArchiveItemPath,
	writeTextFileAtomically,
	type BookmarkArchiveRecord,
} from "./bookmark-markdown-archive";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	);
});

function makeRecord(
	overrides: Partial<BookmarkArchiveRecord> = {},
): BookmarkArchiveRecord {
	return {
		accountId: "acct_primary",
		accountHandle: "friendfish",
		tweetId: "1950123456789012345",
		tweetUrl: "https://x.com/author/status/1950123456789012345",
		authorHandle: "author",
		authorName: "Author Name",
		text: "Read https://t.co/demo",
		tweetCreatedAt: "2026-08-23T10:20:30.000Z",
		bookmarkedAt: null,
		sourceUpdatedAt: "2026-08-24T01:12:00.000Z",
		entities: {
			urls: [
				{
					url: "https://t.co/demo",
					expandedUrl: "https://example.com/demo",
					displayUrl: "example.com/demo",
					start: 5,
					end: 22,
				},
			],
		},
		media: [
			{
				type: "image",
				url: "https://pbs.twimg.com/media/demo.jpg",
				altText: "Architecture diagram",
			},
		],
		...overrides,
	};
}

describe("bookmark markdown archive", () => {
	it("renders parseable metadata and preserves exact user-note bytes", () => {
		const notes = "\n第一遍：重点看并发部分。  \n\n- [ ] 复现实验\n";
		const markdown = renderBookmarkArchiveFile(makeRecord(), {
			firstArchivedAt: "2026-08-24T03:00:01.000Z",
			userNotes: notes,
		});

		expect(markdown).toContain("birdclaw_schema: 1");
		expect(markdown).toContain('account_id: "acct_primary"');
		expect(markdown).toContain('account_handle: "friendfish"');
		expect(markdown).toContain("bookmarked_at: null");
		expect(markdown).toContain(
			"Read [example\\.com/demo](https://example.com/demo)",
		);
		expect(markdown).toContain(
			"- Image: [Architecture diagram](https://pbs.twimg.com/media/demo.jpg)",
		);
		expect(markdown).toContain(
			`<!-- birdclaw:user-notes:start -->${notes}<!-- birdclaw:user-notes:end -->`,
		);

		const parsed = parseBookmarkArchiveFile(markdown);
		expect(parsed.userNotes).toBe(notes);
		expect(parsed.metadata).toMatchObject({
			schemaVersion: 1,
			accountId: "acct_primary",
			accountHandle: "friendfish",
			tweetId: "1950123456789012345",
			authorHandle: "author",
			tweetCreatedAt: "2026-08-23T10:20:30.000Z",
			bookmarkedAt: null,
			firstArchivedAt: "2026-08-24T03:00:01.000Z",
			sourceUpdatedAt: "2026-08-24T01:12:00.000Z",
		});
		expect(parsed.metadata.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it("keeps the managed-content hash independent from user notes", () => {
		const first = parseBookmarkArchiveFile(
			renderBookmarkArchiveFile(makeRecord(), {
				firstArchivedAt: "2026-08-24T03:00:01.000Z",
				userNotes: "\nfirst\n",
			}),
		);
		const second = parseBookmarkArchiveFile(
			renderBookmarkArchiveFile(makeRecord(), {
				firstArchivedAt: "2026-08-24T03:00:01.000Z",
				userNotes: "\nsecond\n",
			}),
		);

		expect(second.metadata.contentHash).toBe(first.metadata.contentHash);
	});

	it("uses stable account/date/tweet paths and a fallback for invalid dates", () => {
		const root = path.resolve("/tmp/bookmark-archive");

		expect(resolveBookmarkArchiveItemPath(root, makeRecord())).toBe(
			path.join(
				root,
				"accounts",
				"acct_primary",
				"2026",
				"08",
				"1950123456789012345.md",
			),
		);
		expect(
			resolveBookmarkArchiveItemPath(
				root,
				makeRecord({ tweetCreatedAt: "not-a-date" }),
			),
		).toBe(
			path.join(
				root,
				"accounts",
				"acct_primary",
				"unknown-date",
				"1950123456789012345.md",
			),
		);
	});

	it("encodes path segments and rejects control characters", () => {
		const root = path.resolve("/tmp/bookmark-archive");
		const resolved = resolveBookmarkArchiveItemPath(
			root,
			makeRecord({ accountId: "account/other", tweetId: "../tweet" }),
		);

		expect(resolved).toContain(
			path.join("accounts", "account%2Fother", "2026", "08", "..%2Ftweet.md"),
		);
		expect(path.relative(root, resolved)).not.toMatch(/^\.\.(?:\/|$)/u);
		expect(() =>
			resolveBookmarkArchiveItemPath(
				root,
				makeRecord({ tweetId: "bad\u0000id" }),
			),
		).toThrow("Invalid bookmark archive path segment");
	});

	it("rejects missing, duplicate, and reversed user-note markers", () => {
		const valid = renderBookmarkArchiveFile(makeRecord(), {
			firstArchivedAt: "2026-08-24T03:00:01.000Z",
			userNotes: "\nnotes\n",
		});
		const start = "<!-- birdclaw:user-notes:start -->";
		const end = "<!-- birdclaw:user-notes:end -->";

		for (const malformed of [
			valid.replace(start, ""),
			valid.replace(end, ""),
			valid.replace(start, `${start}\n${start}`),
			valid.replace(`${start}\nnotes\n${end}`, `${end}\nnotes\n${start}`),
		]) {
			expect(() => parseBookmarkArchiveFile(malformed)).toThrow(
				"Invalid Birdclaw user notes markers",
			);
		}
	});

	it("escapes reserved note markers that appear in managed tweet content", () => {
		const start = "<!-- birdclaw:user-notes:start -->";
		const end = "<!-- birdclaw:user-notes:end -->";
		const markdown = renderBookmarkArchiveFile(
			makeRecord({
				text: `A quoted protocol ${start} example ${end}`,
				entities: {},
			}),
			{
				firstArchivedAt: "2026-08-24T03:00:01.000Z",
				userNotes: "\nprotected notes\n",
			},
		);

		expect(markdown.match(/<!-- birdclaw:user-notes:start -->/gu)).toHaveLength(
			1,
		);
		expect(markdown.match(/<!-- birdclaw:user-notes:end -->/gu)).toHaveLength(
			1,
		);
		expect(markdown).toContain(
			"A quoted protocol &lt;!-- birdclaw:user-notes:start --> example &lt;!-- birdclaw:user-notes:end -->",
		);
		expect(parseBookmarkArchiveFile(markdown).userNotes).toBe(
			"\nprotected notes\n",
		);
	});

	it("atomically replaces a text file without leaving temporary files", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookmark-archive-"));
		tempRoots.push(root);
		const filePath = path.join(root, "nested", "bookmark.md");

		await writeTextFileAtomically(filePath, "first\n");
		await writeTextFileAtomically(filePath, "second\n");

		expect(await fs.readFile(filePath, "utf8")).toBe("second\n");
		expect(await fs.readdir(path.dirname(filePath))).toEqual(["bookmark.md"]);
	});

	it("builds a permanent disk-derived index with deterministic ordering", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookmark-archive-"));
		tempRoots.push(root);
		const fixtures = [
			makeRecord({
				tweetId: "1950000000000000002",
				tweetCreatedAt: "2026-08-23T12:00:00.000Z",
				text: "Newest [bookmark]",
				entities: {},
			}),
			makeRecord({
				tweetId: "1950000000000000001",
				tweetCreatedAt: "2026-08-23T12:00:00.000Z",
				text: "Older tie-break bookmark",
				entities: {},
			}),
			makeRecord({
				accountId: "acct_secondary",
				accountHandle: "secondary",
				tweetId: "1800000000000000000",
				tweetCreatedAt: "2025-01-02T08:00:00.000Z",
				text: "Retained disk-only history",
				entities: {},
			}),
			makeRecord({
				tweetId: "1700000000000000000",
				tweetCreatedAt: "unknown",
				text: "Unknown date bookmark",
				entities: {},
			}),
		];
		for (const record of fixtures) {
			await writeTextFileAtomically(
				resolveBookmarkArchiveItemPath(root, record),
				renderBookmarkArchiveFile(record, {
					firstArchivedAt: "2026-08-24T03:00:00.000Z",
					userNotes: "\n\n",
				}),
			);
		}
		const malformedPath = path.join(
			root,
			"accounts",
			"acct_primary",
			"2026",
			"08",
			"broken.md",
		);
		await writeTextFileAtomically(malformedPath, "not frontmatter\n");

		const index = await buildBookmarkArchiveIndex(
			root,
			"2026-08-24T03:05:00.000Z",
		);

		expect(index.entryCount).toBe(4);
		expect(index.unindexed).toHaveLength(1);
		expect(index.markdown).toContain("- Total archived: 4");
		expect(index.markdown).toContain("- Accounts: 2");
		expect(index.markdown).toContain("- Date range: 2025-01-02 — 2026-08-23");
		expect(index.markdown).toContain("## 2026-08 · 2");
		expect(index.markdown).toContain("## 2025-01 · 1");
		expect(index.markdown).toContain("## Unknown date · 1");
		expect(index.markdown).toContain("## Unindexed files");
		expect(index.markdown).toContain("accounts/acct_primary/2026/08/broken.md");
		expect(index.markdown).toContain("Retained disk-only history");
		expect(index.markdown).toContain("Newest \\[bookmark\\]");
		expect(index.markdown.indexOf("1950000000000000002.md")).toBeLessThan(
			index.markdown.indexOf("1950000000000000001.md"),
		);
	});
});
