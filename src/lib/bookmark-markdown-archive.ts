import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { renderTweetMarkdown, renderTweetPlainText } from "./tweet-render";
import type { TweetEntities, TweetMediaItem } from "./types";

const USER_NOTES_START = "<!-- birdclaw:user-notes:start -->";
const USER_NOTES_END = "<!-- birdclaw:user-notes:end -->";
const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface BookmarkArchiveRecord {
	accountId: string;
	accountHandle: string;
	tweetId: string;
	tweetUrl: string;
	authorHandle: string;
	authorName: string;
	text: string;
	tweetCreatedAt: string;
	bookmarkedAt: string | null;
	sourceUpdatedAt: string;
	entities: TweetEntities;
	media: TweetMediaItem[];
}

export interface BookmarkArchiveMetadata {
	schemaVersion: 1;
	accountId: string;
	accountHandle: string;
	tweetId: string;
	tweetUrl: string;
	authorHandle: string;
	authorName: string;
	tweetCreatedAt: string;
	bookmarkedAt: string | null;
	firstArchivedAt: string;
	sourceUpdatedAt: string;
	contentHash: string;
	excerpt: string;
}

export interface ParsedBookmarkArchiveFile {
	metadata: BookmarkArchiveMetadata;
	userNotes: string;
}

export interface BookmarkArchiveEntry {
	path: string;
	relativePath: string;
	metadata: BookmarkArchiveMetadata;
}

export interface BookmarkArchiveProblem {
	path: string;
	relativePath: string;
	error: string;
	linkable?: boolean;
}

export interface BookmarkArchiveScanResult {
	entries: BookmarkArchiveEntry[];
	unindexed: BookmarkArchiveProblem[];
}

interface RenderBookmarkArchiveState {
	firstArchivedAt: string;
	userNotes: string;
}

interface AtomicWriteOptions {
	containmentRoot?: string;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, stableValue(entry)]),
	);
}

function bookmarkContentHash(record: BookmarkArchiveRecord) {
	const canonical = JSON.stringify(
		stableValue({
			schemaVersion: 1,
			accountId: record.accountId,
			accountHandle: record.accountHandle,
			tweetId: record.tweetId,
			tweetUrl: record.tweetUrl,
			authorHandle: record.authorHandle,
			authorName: record.authorName,
			text: record.text,
			tweetCreatedAt: record.tweetCreatedAt,
			bookmarkedAt: record.bookmarkedAt,
			sourceUpdatedAt: record.sourceUpdatedAt,
			entities: record.entities,
			media: record.media,
		}),
	);
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function excerptForRecord(record: BookmarkArchiveRecord) {
	const plainText = renderTweetPlainText(record.text, record.entities)
		.replaceAll(/\s+/g, " ")
		.trim();
	return Array.from(plainText).slice(0, 160).join("");
}

function safePathSegment(value: string) {
	if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
		throw new Error("Invalid bookmark archive path segment");
	}
	const encoded = encodeURIComponent(value);
	if (encoded === ".") return "%2E";
	if (encoded === "..") return "%2E%2E";
	return encoded;
}

function archiveCalendarDate(value: string) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return null;
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return {
		year,
		month,
		yearMonth: `${year}-${month}`,
		date: `${year}-${month}-${day}`,
	};
}

function assertContainedPath(root: string, candidate: string) {
	const relative = path.relative(root, candidate);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error("Bookmark archive path escapes archive directory");
	}
}

function isErrorCode(error: unknown, code: string) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

async function assertSafeContainedParent(
	containmentRoot: string,
	filePath: string,
	createMissing: boolean,
) {
	const root = path.resolve(containmentRoot);
	const candidate = path.resolve(filePath);
	const directory = path.dirname(candidate);
	assertContainedPath(root, candidate);
	assertContainedPath(root, directory);
	await fs.mkdir(root, { recursive: true });

	let current = root;
	const relativeDirectory = path.relative(root, directory);
	for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		let stats;
		try {
			stats = await fs.lstat(current);
		} catch (error) {
			if (!createMissing || !isErrorCode(error, "ENOENT")) throw error;
			try {
				await fs.mkdir(current);
			} catch (mkdirError) {
				if (!isErrorCode(mkdirError, "EEXIST")) throw mkdirError;
			}
			stats = await fs.lstat(current);
		}
		if (stats.isSymbolicLink()) {
			throw new Error(
				`Bookmark archive path contains a symbolic link: ${current}`,
			);
		}
		if (!stats.isDirectory()) {
			throw new Error(`Bookmark archive parent is not a directory: ${current}`);
		}
	}

	const realRoot = await fs.realpath(root);
	const realDirectory = await fs.realpath(directory);
	assertContainedPath(realRoot, realDirectory);
}

export function resolveBookmarkArchiveItemPath(
	archiveDir: string,
	record: BookmarkArchiveRecord,
) {
	const root = path.resolve(archiveDir);
	const accountSegment = safePathSegment(record.accountId);
	const tweetSegment = safePathSegment(record.tweetId);
	const date = archiveCalendarDate(record.tweetCreatedAt);
	const candidate = date
		? path.resolve(
				root,
				"accounts",
				accountSegment,
				date.year,
				date.month,
				`${tweetSegment}.md`,
			)
		: path.resolve(
				root,
				"accounts",
				accountSegment,
				"unknown-date",
				`${tweetSegment}.md`,
			);
	assertContainedPath(root, candidate);
	return candidate;
}

export function isBookmarkArchiveItemPathForRecord(
	relativePath: string,
	record: BookmarkArchiveRecord,
) {
	const segments = relativePath.split("/");
	return (
		segments.length >= 3 &&
		segments[0] === "accounts" &&
		segments[1] === safePathSegment(record.accountId) &&
		segments.at(-1) === `${safePathSegment(record.tweetId)}.md`
	);
}

function yamlScalar(value: string | number | null) {
	return value === null ? "null" : JSON.stringify(value);
}

function escapeMarkdownLabel(value: string) {
	return value.replaceAll(/([\\`*_[\]<>])/g, "\\$1");
}

function mediaLabel(item: TweetMediaItem) {
	if (item.type === "image") return "Image";
	if (item.type === "video") return "Video";
	if (item.type === "gif") return "GIF";
	return "Media";
}

function renderLinks(record: BookmarkArchiveRecord) {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const item of record.entities.urls ?? []) {
		const url = item.expandedUrl || item.url;
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const label = item.displayUrl || url;
		lines.push(`- [${escapeMarkdownLabel(label)}](${url})`);
	}
	return lines;
}

function renderMedia(record: BookmarkArchiveRecord) {
	return record.media.map((item) => {
		const label = item.altText?.trim() || "View media";
		return `- ${mediaLabel(item)}: [${escapeMarkdownLabel(label)}](${item.url})`;
	});
}

function escapeReservedUserNoteMarkers(value: string) {
	return value
		.replaceAll(USER_NOTES_START, "&lt;!-- birdclaw:user-notes:start -->")
		.replaceAll(USER_NOTES_END, "&lt;!-- birdclaw:user-notes:end -->");
}

export function renderBookmarkArchiveFile(
	record: BookmarkArchiveRecord,
	state: RenderBookmarkArchiveState,
) {
	const metadata: BookmarkArchiveMetadata = {
		schemaVersion: 1,
		accountId: record.accountId,
		accountHandle: record.accountHandle,
		tweetId: record.tweetId,
		tweetUrl: record.tweetUrl,
		authorHandle: record.authorHandle,
		authorName: record.authorName,
		tweetCreatedAt: record.tweetCreatedAt,
		bookmarkedAt: record.bookmarkedAt,
		firstArchivedAt: state.firstArchivedAt,
		sourceUpdatedAt: record.sourceUpdatedAt,
		contentHash: bookmarkContentHash(record),
		excerpt: excerptForRecord(record),
	};
	const frontmatter = [
		"---",
		`birdclaw_schema: ${yamlScalar(metadata.schemaVersion)}`,
		`account_id: ${yamlScalar(metadata.accountId)}`,
		`account_handle: ${yamlScalar(metadata.accountHandle)}`,
		`tweet_id: ${yamlScalar(metadata.tweetId)}`,
		`tweet_url: ${yamlScalar(metadata.tweetUrl)}`,
		`author_handle: ${yamlScalar(metadata.authorHandle)}`,
		`author_name: ${yamlScalar(metadata.authorName)}`,
		`tweet_created_at: ${yamlScalar(metadata.tweetCreatedAt)}`,
		`bookmarked_at: ${yamlScalar(metadata.bookmarkedAt)}`,
		`first_archived_at: ${yamlScalar(metadata.firstArchivedAt)}`,
		`source_updated_at: ${yamlScalar(metadata.sourceUpdatedAt)}`,
		`birdclaw_content_hash: ${yamlScalar(metadata.contentHash)}`,
		`excerpt: ${yamlScalar(metadata.excerpt)}`,
		"---",
	];
	const dateLabel =
		archiveCalendarDate(record.tweetCreatedAt)?.date ?? "Unknown date";
	const lines = [
		...frontmatter,
		"",
		`# @${record.authorHandle} · ${dateLabel}`,
		"",
		"## Bookmark",
		"",
		renderTweetMarkdown(record.text, record.entities),
		"",
	];
	const links = renderLinks(record);
	if (links.length > 0) lines.push("## Links", "", ...links, "");
	const media = renderMedia(record);
	if (media.length > 0) lines.push("## Media", "", ...media, "");
	lines.push(
		"## Source",
		"",
		`- [Open on X](${record.tweetUrl})`,
		`- Tweet ID: \`${record.tweetId}\``,
		"",
		"## My Notes",
		"",
	);
	return `${escapeReservedUserNoteMarkers(lines.join("\n"))}\n${USER_NOTES_START}${state.userNotes}${USER_NOTES_END}\n`;
}

function parseFrontmatter(markdown: string) {
	if (!markdown.startsWith("---\n")) {
		throw new Error("Invalid Birdclaw bookmark frontmatter");
	}
	const closing = markdown.indexOf("\n---\n", 4);
	if (closing < 0) throw new Error("Invalid Birdclaw bookmark frontmatter");
	const values = new Map<string, unknown>();
	for (const line of markdown.slice(4, closing).split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0)
			throw new Error("Invalid Birdclaw bookmark frontmatter");
		const key = line.slice(0, separator).trim();
		if (!key || values.has(key)) {
			throw new Error("Invalid Birdclaw bookmark frontmatter");
		}
		try {
			values.set(key, JSON.parse(line.slice(separator + 1).trim()));
		} catch {
			throw new Error("Invalid Birdclaw bookmark frontmatter");
		}
	}
	return values;
}

function requiredString(values: Map<string, unknown>, key: string) {
	const value = values.get(key);
	if (typeof value !== "string") {
		throw new Error("Invalid Birdclaw bookmark frontmatter");
	}
	return value;
}

function nullableString(values: Map<string, unknown>, key: string) {
	const value = values.get(key);
	if (value !== null && typeof value !== "string") {
		throw new Error("Invalid Birdclaw bookmark frontmatter");
	}
	return value;
}

function extractUserNotes(markdown: string) {
	const start = markdown.indexOf(USER_NOTES_START);
	const end = markdown.indexOf(USER_NOTES_END);
	if (
		start < 0 ||
		end < start + USER_NOTES_START.length ||
		start !== markdown.lastIndexOf(USER_NOTES_START) ||
		end !== markdown.lastIndexOf(USER_NOTES_END)
	) {
		throw new Error("Invalid Birdclaw user notes markers");
	}
	return markdown.slice(start + USER_NOTES_START.length, end);
}

export function parseBookmarkArchiveFile(
	markdown: string,
): ParsedBookmarkArchiveFile {
	const values = parseFrontmatter(markdown);
	if (values.get("birdclaw_schema") !== 1) {
		throw new Error("Invalid Birdclaw bookmark frontmatter");
	}
	const contentHash = requiredString(values, "birdclaw_content_hash");
	if (!CONTENT_HASH_PATTERN.test(contentHash)) {
		throw new Error("Invalid Birdclaw bookmark frontmatter");
	}
	return {
		metadata: {
			schemaVersion: 1,
			accountId: requiredString(values, "account_id"),
			accountHandle: requiredString(values, "account_handle"),
			tweetId: requiredString(values, "tweet_id"),
			tweetUrl: requiredString(values, "tweet_url"),
			authorHandle: requiredString(values, "author_handle"),
			authorName: requiredString(values, "author_name"),
			tweetCreatedAt: requiredString(values, "tweet_created_at"),
			bookmarkedAt: nullableString(values, "bookmarked_at"),
			firstArchivedAt: requiredString(values, "first_archived_at"),
			sourceUpdatedAt: requiredString(values, "source_updated_at"),
			contentHash,
			excerpt: requiredString(values, "excerpt"),
		},
		userNotes: extractUserNotes(markdown),
	};
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

interface MarkdownFileListing {
	files: string[];
	problems: BookmarkArchiveProblem[];
}

function scanProblem(
	root: string,
	problemPath: string,
	error: string,
): BookmarkArchiveProblem {
	return {
		path: problemPath,
		relativePath: relativeArchivePath(root, problemPath),
		error,
		linkable: false,
	};
}

async function listMarkdownFiles(
	root: string,
	directory: string,
): Promise<MarkdownFileListing> {
	let stats;
	try {
		stats = await fs.lstat(directory);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return { files: [], problems: [] };
		return {
			files: [],
			problems: [scanProblem(root, directory, errorMessage(error))],
		};
	}
	if (stats.isSymbolicLink()) {
		return {
			files: [],
			problems: [
				scanProblem(
					root,
					directory,
					"Bookmark archive scan path is a symbolic link",
				),
			],
		};
	}
	if (!stats.isDirectory()) {
		return {
			files: [],
			problems: [
				scanProblem(
					root,
					directory,
					"Bookmark archive scan path is not a directory",
				),
			],
		};
	}

	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		return {
			files: [],
			problems: [scanProblem(root, directory, errorMessage(error))],
		};
	}
	const files: string[] = [];
	const problems: BookmarkArchiveProblem[] = [];
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = await listMarkdownFiles(root, entryPath);
			files.push(...nested.files);
			problems.push(...nested.problems);
		} else if (entry.isSymbolicLink()) {
			problems.push(
				scanProblem(
					root,
					entryPath,
					"Bookmark archive scan path is a symbolic link",
				),
			);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(entryPath);
		}
	}
	return { files, problems };
}

function relativeArchivePath(root: string, filePath: string) {
	return path.relative(root, filePath).split(path.sep).join("/");
}

export async function scanBookmarkArchive(
	archiveDir: string,
): Promise<BookmarkArchiveScanResult> {
	const root = path.resolve(archiveDir);
	const listing = await listMarkdownFiles(root, path.join(root, "accounts"));
	const result: BookmarkArchiveScanResult = {
		entries: [],
		unindexed: listing.problems,
	};
	for (const filePath of listing.files.sort()) {
		const relativePath = relativeArchivePath(root, filePath);
		try {
			const parsed = parseBookmarkArchiveFile(
				await readTextFileWithinDirectory(root, filePath),
			);
			result.entries.push({
				path: filePath,
				relativePath,
				metadata: parsed.metadata,
			});
		} catch (error) {
			result.unindexed.push({
				path: filePath,
				relativePath,
				error: errorMessage(error),
			});
		}
	}
	return result;
}

function compareArchiveEntries(
	left: BookmarkArchiveEntry,
	right: BookmarkArchiveEntry,
) {
	const byCreatedAt = right.metadata.tweetCreatedAt.localeCompare(
		left.metadata.tweetCreatedAt,
	);
	return byCreatedAt === 0
		? right.metadata.tweetId.localeCompare(left.metadata.tweetId)
		: byCreatedAt;
}

function renderIndexEntry(entry: BookmarkArchiveEntry) {
	const date =
		archiveCalendarDate(entry.metadata.tweetCreatedAt)?.date ?? "Unknown date";
	const label = escapeMarkdownLabel(
		`@${entry.metadata.authorHandle} — ${entry.metadata.excerpt}`,
	);
	return `- ${date} · [${label}](${markdownPathDestination(entry.relativePath)})`;
}

function markdownPathDestination(relativePath: string) {
	return relativePath
		.split("/")
		.map((segment) =>
			encodeURIComponent(segment).replaceAll(
				/[!'()*]/gu,
				(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
			),
		)
		.join("/");
}

export async function buildBookmarkArchiveIndex(
	archiveDir: string,
	generatedAt: string,
) {
	const scan = await scanBookmarkArchive(archiveDir);
	const accounts = new Map<string, { handle: string; count: number }>();
	const dated = new Map<string, BookmarkArchiveEntry[]>();
	const unknown: BookmarkArchiveEntry[] = [];
	const calendarDates: string[] = [];
	for (const entry of scan.entries) {
		const account = accounts.get(entry.metadata.accountId);
		accounts.set(entry.metadata.accountId, {
			handle: entry.metadata.accountHandle,
			count: (account?.count ?? 0) + 1,
		});
		const date = archiveCalendarDate(entry.metadata.tweetCreatedAt);
		if (!date) {
			unknown.push(entry);
			continue;
		}
		calendarDates.push(date.date);
		const monthEntries = dated.get(date.yearMonth) ?? [];
		monthEntries.push(entry);
		dated.set(date.yearMonth, monthEntries);
	}
	calendarDates.sort();
	const dateRange =
		calendarDates.length > 0
			? `${calendarDates[0]} — ${calendarDates.at(-1)}`
			: "Unknown";
	const lines = [
		"# Bookmark Archive",
		"",
		`- Total archived: ${String(scan.entries.length)}`,
		`- Accounts: ${String(accounts.size)}`,
		`- Date range: ${dateRange}`,
		`- Last export: ${generatedAt}`,
		"",
		"## Accounts",
		"",
	];
	for (const [accountId, account] of [...accounts.entries()].sort(
		([leftId, left], [rightId, right]) =>
			left.handle.localeCompare(right.handle) || leftId.localeCompare(rightId),
	)) {
		lines.push(
			`- @${escapeMarkdownLabel(account.handle)} (\`${accountId}\`): ${String(account.count)}`,
		);
	}
	lines.push("");
	for (const month of [...dated.keys()].sort().reverse()) {
		const entries = dated.get(month) ?? [];
		entries.sort(compareArchiveEntries);
		lines.push(`## ${month} · ${String(entries.length)}`, "");
		for (const entry of entries) lines.push(renderIndexEntry(entry));
		lines.push("");
	}
	if (unknown.length > 0) {
		unknown.sort(compareArchiveEntries);
		lines.push(`## Unknown date · ${String(unknown.length)}`, "");
		for (const entry of unknown) lines.push(renderIndexEntry(entry));
		lines.push("");
	}
	if (scan.unindexed.length > 0) {
		lines.push("## Unindexed files", "");
		for (const problem of scan.unindexed) {
			const problemLabel = escapeMarkdownLabel(problem.relativePath);
			const problemLocation =
				problem.linkable === false
					? problemLabel
					: `[${problemLabel}](${markdownPathDestination(problem.relativePath)})`;
			lines.push(`- ${problemLocation}: ${escapeMarkdownLabel(problem.error)}`);
		}
		lines.push("");
	}
	return {
		markdown: `${lines.join("\n").trimEnd()}\n`,
		entryCount: scan.entries.length,
		unindexed: scan.unindexed,
	};
}

export async function readTextFileWithinDirectory(
	containmentRoot: string,
	filePath: string,
) {
	await assertSafeContainedParent(containmentRoot, filePath, false);
	const stats = await fs.lstat(filePath);
	if (stats.isSymbolicLink()) {
		throw new Error(`Bookmark archive file is a symbolic link: ${filePath}`);
	}
	if (!stats.isFile()) {
		throw new Error(`Bookmark archive path is not a file: ${filePath}`);
	}
	return fs.readFile(filePath, "utf8");
}

export async function writeTextFileAtomically(
	filePath: string,
	content: string,
	options: AtomicWriteOptions = {},
) {
	const directory = path.dirname(filePath);
	if (options.containmentRoot) {
		await assertSafeContainedParent(options.containmentRoot, filePath, true);
	} else {
		await fs.mkdir(directory, { recursive: true });
	}
	const temporaryPath = path.join(
		directory,
		`.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await fs.writeFile(temporaryPath, content, "utf8");
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}
