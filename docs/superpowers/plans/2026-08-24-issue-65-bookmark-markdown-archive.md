# Bookmark Markdown Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Issue #65 as a deterministic local bookmark-to-Markdown archive with configurable storage, protected user notes, a permanent panoramic index, manual export, and daily launchd scheduling.

**Architecture:** Add a focused Markdown protocol module, a database-backed export orchestrator, and a thin scheduled-job wrapper. The exporter scans the selected account's local bookmark collection, writes only new or changed files, never deletes historical files, rebuilds `INDEX.md` from the archive on disk, and preserves the exact bytes inside the user-notes markers.

**Tech Stack:** TypeScript, Node.js filesystem/crypto APIs, native SQLite wrapper, Effect adapters used by scheduled jobs, Commander CLI, Vitest, launchd plist helpers.

**Source Specification:** [GitHub Issue #65](https://github.com/friendfish/birdclaw/issues/65)

---

## File Map

- Create `src/lib/bookmark-markdown-archive.ts`: archive path validation, frontmatter protocol, note extraction/preservation, deterministic item rendering, archive scanning, index rendering, and atomic text writes.
- Create `src/lib/bookmark-markdown-archive.test.ts`: protocol, path, notes, index, malformed-file, ordering, and atomic-write tests.
- Create `src/lib/bookmark-export.ts`: selected-account repository query and incremental/full export orchestration.
- Create `src/lib/bookmark-export.test.ts`: real temporary SQLite and filesystem integration tests.
- Create `src/lib/bookmark-export-job.ts`: scheduled lock/audit wrapper plus daily launchd builder/installer.
- Create `src/lib/bookmark-export-job.test.ts`: lock, audit, calendar plist, path expansion, and argument tests.
- Create `src/cli/register-bookmarks.ts`: `bookmarks export` command.
- Modify `src/lib/config.ts` and `src/lib/config.test.ts`: bookmark archive directory and schedule configuration.
- Modify `src/cli.ts`, `src/cli/register-jobs.ts`, and `src/cli.test.ts`: register manual and scheduled commands.
- Create `docs/bookmark-archive.md`; modify `docs/configuration.md`, `docs/jobs.md`, `docs/cli.md`, `docs/index.md`, `scripts/build-docs-site.mjs`, and `README.md`.

---

### Task 1: Configuration And Archive Protocol

**Files:**
- Create: `src/lib/bookmark-markdown-archive.ts`
- Create: `src/lib/bookmark-markdown-archive.test.ts`
- Modify: `src/lib/config.ts`
- Modify: `src/lib/config.test.ts`

- [x] **Step 1: Write failing configuration tests**

Add tests that establish the public API and precedence:

```ts
expect(resolveBookmarkArchiveDir()).toBe(path.join(tempRoot, "bookmark-archive"));
expect(resolveBookmarkArchiveDir("~/urgent-bookmarks")).toBe(
	path.join(os.homedir(), "urgent-bookmarks"),
);
expect(resolveBookmarkExportSchedule()).toEqual({ hour: 3, minute: 0 });
```

Write a config fixture with `bookmarks.archiveDir` and `bookmarks.exportSchedule`, then assert valid hour/minute values are used and invalid values fall back independently to 03:00.

- [x] **Step 2: Run configuration tests and verify RED**

Run:

```bash
pnpm test src/lib/config.test.ts
```

Expected: FAIL because `resolveBookmarkArchiveDir`, `resolveBookmarkExportSchedule`, and the `bookmarks` config shape do not exist.

- [x] **Step 3: Implement minimal configuration support**

Add this shape and resolvers:

```ts
export interface BookmarkExportSchedule {
	hour?: number;
	minute?: number;
}

export interface BirdclawConfig {
	bookmarks?: {
		archiveDir?: string;
		exportSchedule?: BookmarkExportSchedule;
	};
	// existing sections remain unchanged
}

export function resolveBookmarkArchiveDir(requested?: string) {
	const value = requested?.trim() || getBirdclawConfig().bookmarks?.archiveDir?.trim();
	return value
		? resolveUserPath(value)
		: path.join(getBirdclawPaths().rootDir, "bookmark-archive");
}

export function resolveBookmarkExportSchedule() {
	const configured = getBirdclawConfig().bookmarks?.exportSchedule;
	return {
		hour: validHour(configured?.hour) ? configured.hour : 3,
		minute: validMinute(configured?.minute) ? configured.minute : 0,
	};
}
```

Use the existing user-path expansion behavior without introducing an environment override that Issue #65 did not request.

- [x] **Step 4: Write failing protocol tests**

Define the wished-for API with one complete fixture:

```ts
const record: BookmarkArchiveRecord = {
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
		urls: [{
			url: "https://t.co/demo",
			expandedUrl: "https://example.com/demo",
			displayUrl: "example.com/demo",
			start: 5,
			end: 22,
		}],
	},
	media: [],
};

const rendered = renderBookmarkArchiveFile(record, {
	firstArchivedAt: "2026-08-24T03:00:01.000Z",
	userNotes: "\nKeep this exact.\n",
});
expect(rendered).toContain("birdclaw_schema: 1");
expect(rendered).toContain("<!-- birdclaw:user-notes:start -->\nKeep this exact.\n<!-- birdclaw:user-notes:end -->");
```

Add separate tests for stable paths, `unknown-date`, path containment, null `bookmarked_at`, YAML-safe quoted scalar values, and malformed/duplicate/reversed note markers.

- [x] **Step 5: Run protocol tests and verify RED**

Run:

```bash
pnpm test src/lib/bookmark-markdown-archive.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 6: Implement the protocol and atomic writer**

Implement these exported boundaries:

```ts
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
export interface ParsedBookmarkArchiveFile {
	metadata: BookmarkArchiveMetadata;
	userNotes: string;
}
export function resolveBookmarkArchiveItemPath(root: string, record: BookmarkArchiveRecord): string;
export function renderBookmarkArchiveFile(record: BookmarkArchiveRecord, state: RenderState): string;
export function parseBookmarkArchiveFile(markdown: string): ParsedBookmarkArchiveFile;
export async function writeTextFileAtomically(filePath: string, content: string): Promise<void>;
```

Use `renderTweetMarkdown`, SHA-256 over canonical Birdclaw-managed data, strict marker cardinality/order checks, adjacent temporary files, and `rename`. Validate account/tweet path segments before joining them beneath `<root>/accounts/...`.

- [x] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
pnpm test src/lib/config.test.ts src/lib/bookmark-markdown-archive.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/lib/config.ts src/lib/config.test.ts src/lib/bookmark-markdown-archive.ts src/lib/bookmark-markdown-archive.test.ts
git commit -m "feat: define bookmark markdown archive protocol"
```

---

### Task 2: Permanent Index And Incremental Export

**Files:**
- Modify: `src/lib/bookmark-markdown-archive.ts`
- Modify: `src/lib/bookmark-markdown-archive.test.ts`
- Create: `src/lib/bookmark-export.ts`
- Create: `src/lib/bookmark-export.test.ts`

- [x] **Step 1: Write failing index tests**

Create archive fixtures for two accounts, multiple months, one `unknown-date` file, one retained file absent from the database, and one malformed file. Assert:

```ts
const index = await buildBookmarkArchiveIndex(archiveDir, generatedAt);
expect(index.entryCount).toBe(4);
expect(index.markdown).toContain("## 2026-08 · 2");
expect(index.markdown).toContain("## Unindexed files");
expect(index.markdown).toContain("accounts/acct_primary/2026/08/1950.md");
```

Also assert newest-month/newest-tweet ordering, stable tweet-ID tie breaking, relative links, escaped excerpts, account totals, and preservation of historical disk-only files.

- [x] **Step 2: Run index tests and verify RED**

Run:

```bash
pnpm test src/lib/bookmark-markdown-archive.test.ts
```

Expected: FAIL because archive scanning/index generation does not exist.

- [x] **Step 3: Implement archive scanning and index rendering**

Add:

```ts
export async function scanBookmarkArchive(root: string): Promise<BookmarkArchiveScanResult>;
export async function buildBookmarkArchiveIndex(
	root: string,
	generatedAt: string,
): Promise<{ markdown: string; entryCount: number; unindexed: BookmarkArchiveProblem[] }>;
```

Scan only `accounts/**/*.md`, exclude `INDEX.md`, parse controlled metadata, keep malformed files in an `Unindexed files` section, and generate the complete deterministic index from disk rather than from the current bookmark query.

- [x] **Step 4: Write failing export integration tests**

Using `createTestHome`, `insertTestAccount`, `insertTestProfile`, and `insertTestTweet`, insert bookmark collection rows and assert the public service:

```ts
const first = await exportBookmarks({ db, archiveDir, now });
expect(first).toMatchObject({ created: 2, updated: 0, unchanged: 0, conflicted: 0 });

const second = await exportBookmarks({ db, archiveDir, now });
expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
```

Add independent tests for source changes preserving notes, `full: true`, user-deleted file recreation, malformed-marker conflicts, no deletion of disk-only history, selected-account isolation, the same tweet in two accounts, and accurate null bookmark timestamps.

- [x] **Step 5: Run export tests and verify RED**

Run:

```bash
pnpm test src/lib/bookmark-export.test.ts
```

Expected: FAIL because `exportBookmarks` does not exist.

- [x] **Step 6: Implement repository query and export orchestration**

Expose:

```ts
export interface BookmarkExportOptions {
	account?: string;
	archiveDir?: string;
	full?: boolean;
	db?: Database;
	now?: () => Date;
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
	errors: Array<{ path: string; error: string }>;
	startedAt: string;
	finishedAt: string;
}

export async function exportBookmarks(options?: BookmarkExportOptions): Promise<BookmarkExportResult>;
```

Resolve exactly one account with `findOperationAccount`, query `tweet_collections` joined to live `tweets` and `profiles`, parse entities/media with `parseJsonField`, render current records, compare managed content hashes, preserve valid notes, never delete, build/write the index last, and continue after per-item failures while returning `ok: false` when conflicts/errors exist.

- [x] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
pnpm test src/lib/bookmark-markdown-archive.test.ts src/lib/bookmark-export.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/lib/bookmark-markdown-archive.ts src/lib/bookmark-markdown-archive.test.ts src/lib/bookmark-export.ts src/lib/bookmark-export.test.ts
git commit -m "feat: export bookmarks incrementally with permanent index"
```

---

### Task 3: Manual CLI

**Files:**
- Create: `src/cli/register-bookmarks.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

- [x] **Step 1: Write failing CLI tests**

Mock `exportBookmarks`, then assert:

```ts
await runCli([
	"node", "birdclaw", "bookmarks", "export",
	"--account", "acct_primary",
	"--archive-dir", "~/Desktop/bookmarks",
	"--full",
]);

expect(exportBookmarksMock).toHaveBeenCalledWith({
	account: "acct_primary",
	archiveDir: "~/Desktop/bookmarks",
	full: true,
});
```

Assert human output summarizes counts, global `--json` prints the full result, and a partial failure sets `process.exitCode = 1`.

- [x] **Step 2: Run CLI tests and verify RED**

Run:

```bash
pnpm test src/cli.test.ts
```

Expected: FAIL because `bookmarks export` is unknown.

- [x] **Step 3: Register the command**

Create a focused registrar:

```ts
export function registerBookmarkCommands({ program, print, asJson }: CliCommandContext) {
	program.command("bookmarks")
		.description("Archive local bookmarks as Markdown")
		.command("export")
		.option("--account <username>", "Account username or id")
		.option("--archive-dir <path>", "Override the configured archive directory")
		.option("--full", "Re-render all current bookmark files")
		.action(async (options) => {
			const result = await exportBookmarks({
				account: options.account,
				archiveDir: options.archiveDir,
				full: Boolean(options.full),
			});
			print(
				asJson()
					? result
					: `Bookmark archive: ${String(result.created)} created, ${String(result.updated)} updated, ${String(result.unchanged)} unchanged, ${String(result.conflicted)} conflicted`,
				asJson(),
			);
			if (!result.ok) process.exitCode = 1;
		});
}
```

Register it in `src/cli.ts`. Do not sync, query X, or call backup hooks.

- [x] **Step 4: Run CLI and export tests and verify GREEN**

Run:

```bash
pnpm test src/cli.test.ts src/lib/bookmark-export.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/cli.ts src/cli/register-bookmarks.ts src/cli.test.ts
git commit -m "feat: add manual bookmark archive command"
```

---

### Task 4: Scheduled Job And Daily LaunchAgent

**Files:**
- Create: `src/lib/bookmark-export-job.ts`
- Create: `src/lib/bookmark-export-job.test.ts`
- Modify: `src/cli/register-jobs.ts`
- Modify: `src/cli.test.ts`

- [x] **Step 1: Write failing job tests**

Cover one successful run, exporter failure audit, already-running skip, and launchd construction:

```ts
const agent = buildBookmarkExportLaunchAgentPlist({ hour: 4, minute: 15 });
expect(agent.schedule).toEqual({ kind: "calendar", hour: 4, minute: 15 });
expect(agent.programArguments).toContain("export-bookmarks");
expect(agent.runAtLoad).toBe(false);
```

Assert default paths use `audit/bookmark-export.jsonl`, `locks/bookmark-export.lock`, and `logs/bookmark-export.*.log`; assert archive/account/full/log options are safely forwarded.

- [x] **Step 2: Run job tests and verify RED**

Run:

```bash
pnpm test src/lib/bookmark-export-job.test.ts
```

Expected: FAIL because the job module does not exist.

- [x] **Step 3: Implement the scheduled wrapper and installer**

Expose:

```ts
export function runBookmarkExportJobEffect(options?: BookmarkExportJobOptions): Effect.Effect<BookmarkExportAuditEntry, unknown>;
export function runBookmarkExportJob(options?: BookmarkExportJobOptions): Promise<BookmarkExportAuditEntry>;
export function buildBookmarkExportLaunchAgentPlist(options?: BookmarkExportLaunchAgentOptions): LaunchAgent;
export function installBookmarkExportLaunchAgent(options?: BookmarkExportLaunchAgentOptions): Promise<LaunchAgentInstallResult>;
```

Reuse `startScheduledJobRun`, `acquireScheduledJobLockEffect`, `appendScheduledJobAuditEffect`, `buildLaunchAgent`, `buildLaunchProgramArguments`, and `installLaunchAgentEffect`. Calendar schedule defaults come from `resolveBookmarkExportSchedule`; set `runAtLoad: false` so installing a daily exporter does not unexpectedly run it immediately.

- [x] **Step 4: Write failing scheduled CLI tests**

Assert argument forwarding for:

```bash
birdclaw --json jobs export-bookmarks --account acct_primary --archive-dir ~/archive --full
birdclaw --json jobs install-bookmark-export-launchd --hour 4 --minute 15 --program /opt/homebrew/bin/birdclaw
```

Validate hour `0..23` and minute `0..59` before dispatch and set exit code for a failed export audit.

- [x] **Step 5: Run CLI tests and verify RED**

Run:

```bash
pnpm test src/cli.test.ts
```

Expected: FAIL because the new `jobs` subcommands are unknown.

- [x] **Step 6: Register scheduled commands and verify GREEN**

Add `jobs export-bookmarks` and `jobs install-bookmark-export-launchd` to `registerJobCommands`, forwarding only explicit overrides so config defaults remain effective.

Run:

```bash
pnpm test src/lib/bookmark-export-job.test.ts src/cli.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/lib/bookmark-export-job.ts src/lib/bookmark-export-job.test.ts src/cli/register-jobs.ts src/cli.test.ts
git commit -m "feat: schedule daily bookmark archive exports"
```

---

### Task 5: Documentation, Full Verification, Review, And PR

**Files:**
- Create: `docs/bookmark-archive.md`
- Modify: `docs/configuration.md`
- Modify: `docs/jobs.md`
- Modify: `docs/cli.md`
- Modify: `docs/index.md`
- Modify: `scripts/build-docs-site.mjs`
- Modify: `README.md`

- [x] **Step 1: Document the three separate workflows**

Write exact examples for:

```bash
birdclaw sync bookmarks --mode auto --all --refresh --json
birdclaw bookmarks export
birdclaw bookmarks export --full
birdclaw jobs install-bookmark-export-launchd --hour 3 --minute 0
birdclaw research "codex" --out ~/research/codex.md
```

Document config precedence, directory layout, permanent retention, the user-notes ownership boundary, null bookmark timestamps, daily local-only scheduling, audit/lock paths, multi-account isolation, and the absence of implicit X access or media downloads.

- [x] **Step 2: Build the docs site and run targeted checks**

Run:

```bash
pnpm run docs:site
pnpm test src/lib/config.test.ts src/lib/bookmark-markdown-archive.test.ts src/lib/bookmark-export.test.ts src/lib/bookmark-export-job.test.ts src/cli.test.ts
```

Expected: docs build succeeds and focused tests pass.

- [x] **Step 3: Commit documentation**

```bash
git add README.md docs/bookmark-archive.md docs/configuration.md docs/jobs.md docs/cli.md docs/index.md scripts/build-docs-site.mjs
git commit -m "docs: explain bookmark markdown archives"
```

- [x] **Step 4: Run complete verification**

Run:

```bash
pnpm run check
pnpm test
pnpm run build
pnpm run pack:smoke
```

Expected: every command exits 0. Record the Node engine warning separately if the host remains on 26.4.0.

- [x] **Step 5: Review the diff against Issue #65**

Check every acceptance item: no deletes, no network calls, exact note preservation, disk-derived index, atomic writes, account isolation, lock/audit behavior, CLI JSON, schedule validation, and documentation. Run a placeholder scan and ensure no temporary files or generated docs output are tracked.

- [x] **Step 6: Request code review and fix findings with TDD**

Use `superpowers:requesting-code-review`. For each valid finding, add or strengthen a failing regression test before changing production code, then rerun focused and full verification.

- [x] **Step 7: Push and create the PR**

```bash
git push -u origin codex/issue-65-bookmark-markdown-archive
gh pr create --repo friendfish/birdclaw --base main --head codex/issue-65-bookmark-markdown-archive --title "feat: archive bookmarks as Markdown" --body-file <prepared-pr-body>
```

The PR body must link `Closes #65`, summarize the architecture and user-visible commands, list verification evidence, and call out the non-fatal Node 26.4.0 versus required 26.5.0 engine warning if it remains.

---

## Post-Review Hardening For PR #67

The detailed review originally posted during PR #66 was re-evaluated against
the successor PR #67 branch. The resulting changes are intentionally split
between behavioral fixes, test corrections, and documented product boundaries:

- [x] Treat an unparseable same-account, same-tweet file under an older date
  path as a conflict instead of creating a duplicate archive item.
- [x] Use the tweet timestamp's local calendar date consistently for the item
  path, generated heading, index date, date range, and monthly grouping; compare
  complete rendered output so a timezone change refreshes managed dates without
  moving the stable file path.
- [x] Exercise the real default lock-path implementation in the scheduled-job
  test rather than mocking the function under assertion.
- [x] Document that source Markdown may resemble generated headings and that
  the exact user-note marker pair remains the ownership boundary.
- [x] Truncate index excerpts by Unicode code point so a surrogate pair is not
  split.
- [x] Reuse the shared scheduled-job lock expiry constant in manual and
  scheduled bookmark exports.
- [x] Replace schedule-validation sentinel expressions with a named field
  resolver.
- [x] Record the implementation checklist and this review follow-up in the
  plan.
- [x] Document one-account-per-run behavior, unique labels, staggered schedules,
  and the non-queuing lock behavior for multi-account LaunchAgents.

### Final Re-Verification

- [x] `pnpm check`
- [x] `pnpm test` (186 files, 1907 tests)
- [x] `pnpm coverage` (88.51% statements, 80.58% branches, 88.23%
  functions, 90.07% lines)
- [x] `pnpm run build`
- [x] `pnpm run pack:smoke` (149 packaged files)
- [x] `pnpm run docs:site`
- [x] Independent review of the final PR #67 diff (no remaining findings;
  ready to merge)

All commands exited successfully on Node 26.4.0. pnpm reported the expected
non-fatal engine warning because the repository declares Node 26.5.0 or newer.
