import path from "node:path";
import { findOperationAccount } from "./account-selection";
import {
	buildBookmarkArchiveIndex,
	isBookmarkArchiveItemPathForRecord,
	parseBookmarkArchiveFile,
	readTextFileWithinDirectory,
	renderBookmarkArchiveFile,
	resolveBookmarkArchiveItemPath,
	scanBookmarkArchive,
	writeTextFileAtomically,
	type BookmarkArchiveEntry,
	type BookmarkArchiveRecord,
} from "./bookmark-markdown-archive";
import { getBirdclawPaths, resolveBookmarkArchiveDir } from "./config";
import { getNativeDb } from "./db";
import { resolveUserPath } from "./launchd";
import { parseJsonField } from "./query-read-model-shared";
import {
	acquireScheduledJobLock,
	DEFAULT_SCHEDULED_JOB_LOCK_MAX_AGE_MS,
} from "./scheduled-job";
import type { Database } from "./sqlite";
import type { TweetEntities, TweetMediaItem } from "./types";

interface BookmarkExportRow {
	account_id: string;
	account_handle: string;
	tweet_id: string;
	text: string;
	tweet_created_at: string;
	entities_json: string;
	media_json: string;
	author_handle: string;
	author_name: string;
	collected_at: string | null;
	source_updated_at: string;
}

export interface BookmarkExportOptions {
	account?: string;
	archiveDir?: string;
	full?: boolean;
	db?: Database;
	now?: () => Date;
	lockPath?: string;
	acquireLock?: boolean;
}

export interface BookmarkExportError {
	path: string;
	error: string;
}

export interface BookmarkExportResult {
	ok: boolean;
	accountId: string;
	archiveDir: string;
	mode: "incremental" | "full";
	created: number;
	updated: number;
	unchanged: number;
	conflicted: number;
	indexEntries: number;
	errors: BookmarkExportError[];
	startedAt: string;
	finishedAt: string;
	skipped?: "already-running";
}

export function getDefaultBookmarkExportLockPath() {
	return path.join(getBirdclawPaths().rootDir, "locks", "bookmark-export.lock");
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function normalizedHandle(value: string) {
	return value.replace(/^@/, "");
}

function readBookmarkRows(db: Database, accountId: string) {
	return db
		.prepare(
			`select
				tc.account_id,
				a.handle as account_handle,
				t.id as tweet_id,
				t.text,
				t.created_at as tweet_created_at,
				t.entities_json,
				t.media_json,
				p.handle as author_handle,
				p.display_name as author_name,
				tc.collected_at,
				tc.updated_at as source_updated_at
			 from tweet_collections tc
			 join accounts a on a.id = tc.account_id
			 join tweets t on t.id = tc.tweet_id
			 join profiles p on p.id = t.author_profile_id
			 where tc.account_id = ?
			   and tc.kind = 'bookmarks'
			   and t.deleted_at is null
			   and t.superseded_at is null
			 order by t.created_at desc, t.id desc`,
		)
		.all(accountId) as BookmarkExportRow[];
}

function toArchiveRecord(row: BookmarkExportRow): BookmarkArchiveRecord {
	const authorHandle = normalizedHandle(row.author_handle);
	return {
		accountId: row.account_id,
		accountHandle: normalizedHandle(row.account_handle),
		tweetId: row.tweet_id,
		tweetUrl: `https://x.com/${authorHandle}/status/${row.tweet_id}`,
		authorHandle,
		authorName: row.author_name,
		text: row.text,
		tweetCreatedAt: row.tweet_created_at,
		bookmarkedAt: row.collected_at,
		sourceUpdatedAt: row.source_updated_at,
		entities: parseJsonField<TweetEntities>(row.entities_json, {}),
		media: parseJsonField<TweetMediaItem[]>(row.media_json, []),
	};
}

function bookmarkIdentity(accountId: string, tweetId: string) {
	return JSON.stringify([accountId, tweetId]);
}

function unresolvedBookmarkLocation(
	archiveDir: string,
	row: BookmarkExportRow,
) {
	return `${path.join(archiveDir, "accounts")} [account=${JSON.stringify(row.account_id)}, tweet=${JSON.stringify(row.tweet_id)}]`;
}

function groupArchiveEntriesByIdentity(entries: BookmarkArchiveEntry[]) {
	const grouped = new Map<string, BookmarkArchiveEntry[]>();
	for (const entry of entries) {
		const key = bookmarkIdentity(
			entry.metadata.accountId,
			entry.metadata.tweetId,
		);
		const matches = grouped.get(key) ?? [];
		matches.push(entry);
		grouped.set(key, matches);
	}
	return grouped;
}

async function readExistingFile(archiveDir: string, filePath: string) {
	try {
		return await readTextFileWithinDirectory(archiveDir, filePath);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

export async function exportBookmarks(
	options: BookmarkExportOptions = {},
): Promise<BookmarkExportResult> {
	const db = options.db ?? getNativeDb();
	const account = findOperationAccount(db, options.account);
	if (!account) {
		throw new Error(`Unknown account: ${options.account?.trim() || "default"}`);
	}
	const archiveDir = resolveBookmarkArchiveDir(options.archiveDir);
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const mode = options.full ? "full" : "incremental";
	if (options.acquireLock !== false) {
		const lockPath = resolveUserPath(
			options.lockPath ?? getDefaultBookmarkExportLockPath(),
		);
		const releaseLock = await acquireScheduledJobLock(
			lockPath,
			DEFAULT_SCHEDULED_JOB_LOCK_MAX_AGE_MS,
		);
		if (!releaseLock) {
			return {
				ok: true,
				accountId: account.id,
				archiveDir,
				mode,
				created: 0,
				updated: 0,
				unchanged: 0,
				conflicted: 0,
				indexEntries: 0,
				errors: [],
				startedAt,
				finishedAt: now().toISOString(),
				skipped: "already-running",
			};
		}
		try {
			return await exportBookmarks({
				...options,
				account: account.id,
				archiveDir,
				acquireLock: false,
			});
		} finally {
			await releaseLock().catch(() => undefined);
		}
	}
	const errorsByPath = new Map<string, string>();
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	let conflicted = 0;
	const initialScan = await scanBookmarkArchive(archiveDir);
	const existingEntries = groupArchiveEntriesByIdentity(initialScan.entries);

	for (const row of readBookmarkRows(db, account.id)) {
		let errorPath = unresolvedBookmarkLocation(archiveDir, row);
		try {
			const record = toArchiveRecord(row);
			const filePath = resolveBookmarkArchiveItemPath(archiveDir, record);
			errorPath = filePath;
			const unindexedMatches = initialScan.unindexed.filter((problem) =>
				isBookmarkArchiveItemPathForRecord(problem.relativePath, record),
			);
			if (unindexedMatches.length > 0) {
				errorPath = unindexedMatches[0].path;
				throw new Error(
					unindexedMatches.length === 1
						? unindexedMatches[0].error
						: `Multiple unparseable archive files exist for account ${record.accountId} and tweet ${record.tweetId}: ${unindexedMatches.map((problem) => problem.path).join(", ")}`,
				);
			}
			const matches =
				existingEntries.get(
					bookmarkIdentity(record.accountId, record.tweetId),
				) ?? [];
			let existingPath = filePath;
			let existing = await readExistingFile(archiveDir, filePath);
			const otherMatches = matches.filter(
				(entry) => path.resolve(entry.path) !== path.resolve(filePath),
			);
			if (existing !== undefined && otherMatches.length > 0) {
				throw new Error(
					`Multiple archive files exist for account ${record.accountId} and tweet ${record.tweetId}: ${[filePath, ...otherMatches.map((entry) => entry.path)].join(", ")}`,
				);
			}
			if (existing === undefined && matches.length > 1) {
				throw new Error(
					`Multiple archive files exist for account ${record.accountId} and tweet ${record.tweetId}: ${matches.map((entry) => entry.path).join(", ")}`,
				);
			}
			if (existing === undefined && matches.length === 1) {
				existingPath = matches[0].path;
				existing = await readExistingFile(archiveDir, existingPath);
			}
			if (existing === undefined) {
				await writeTextFileAtomically(
					filePath,
					renderBookmarkArchiveFile(record, {
						firstArchivedAt: startedAt,
						userNotes: "\n\n",
					}),
					{ containmentRoot: archiveDir },
				);
				created += 1;
				continue;
			}

			const parsedExisting = parseBookmarkArchiveFile(existing);
			const rendered = renderBookmarkArchiveFile(record, {
				firstArchivedAt: parsedExisting.metadata.firstArchivedAt,
				userNotes: parsedExisting.userNotes,
			});
			const nextHash = parseBookmarkArchiveFile(rendered).metadata.contentHash;
			if (
				!options.full &&
				nextHash === parsedExisting.metadata.contentHash &&
				rendered === existing
			) {
				unchanged += 1;
				continue;
			}

			await writeTextFileAtomically(existingPath, rendered, {
				containmentRoot: archiveDir,
			});
			updated += 1;
		} catch (error) {
			conflicted += 1;
			errorsByPath.set(errorPath, errorMessage(error));
		}
	}

	const indexGeneratedAt = now().toISOString();
	let indexEntries = 0;
	try {
		const index = await buildBookmarkArchiveIndex(archiveDir, indexGeneratedAt);
		indexEntries = index.entryCount;
		for (const problem of index.unindexed) {
			errorsByPath.set(problem.path, problem.error);
		}
		await writeTextFileAtomically(
			path.join(archiveDir, "INDEX.md"),
			index.markdown,
			{ containmentRoot: archiveDir },
		);
	} catch (error) {
		errorsByPath.set(path.join(archiveDir, "INDEX.md"), errorMessage(error));
	}
	const finishedAt = now().toISOString();

	const errors = [...errorsByPath.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([errorPath, error]) => ({ path: errorPath, error }));
	return {
		ok: errors.length === 0,
		accountId: account.id,
		archiveDir,
		mode,
		created,
		updated,
		unchanged,
		conflicted,
		indexEntries,
		errors,
		startedAt,
		finishedAt,
	};
}
