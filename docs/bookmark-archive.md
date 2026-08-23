---
title: Bookmark Markdown Archive
description: "Export local X bookmarks as permanent Markdown files with protected notes, a panoramic index, and daily scheduling."
---

# Bookmark Markdown Archive

The bookmark archive turns Birdclaw's locally stored X bookmarks into a durable reading library. Each bookmark gets its own Markdown file, user notes have an explicit protected region, and the root `INDEX.md` summarizes every valid file still on disk.

This is different from two related workflows:

- `sync bookmarks` fetches bookmark state from X into local SQLite.
- `bookmarks export` reads local SQLite and updates the Markdown archive. It never contacts X.
- `research` creates one topic-oriented brief, may expand missing threads live, and does not maintain the permanent archive.

## Manual export

Export new and changed local bookmarks:

```bash
birdclaw bookmarks export
```

Use an urgent one-run destination or rebuild every currently bookmarked file:

```bash
birdclaw bookmarks export --archive-dir ~/Documents/bookmarks
birdclaw bookmarks export --full
birdclaw --json bookmarks export --account acct_primary
```

Normal incremental runs do not rewrite unchanged item files. `--full` re-renders the Birdclaw-managed parts of every current bookmark, while preserving valid user-note regions exactly. A current bookmark file that was deleted by hand is created again on the next run.

The command reports `created`, `updated`, `unchanged`, `conflicted`, and `indexEntries`. A conflict or unindexed archive file makes `ok` false and sets a non-zero CLI exit code; the original item file is left untouched.

Manual and scheduled exports share
`~/.birdclaw/locks/bookmark-export.lock`. If another export is active, the
manual command returns `skipped: "already-running"` without writing item files
or `INDEX.md`.

## Configure the directory and daily time

Add the optional `bookmarks` section to `~/.birdclaw/config.json`:

```json
{
	"bookmarks": {
		"archiveDir": "~/Documents/birdclaw-bookmarks",
		"exportSchedule": {
			"hour": 3,
			"minute": 0
		}
	}
}
```

Archive directory precedence is:

1. `--archive-dir` for the current command or installed job
2. `bookmarks.archiveDir` in the config file
3. `~/.birdclaw/bookmark-archive`

The schedule defaults to 03:00 local time. Explicit installer flags override config fields independently; omitting them keeps the configured values.

## Daily export on macOS

Install a daily LaunchAgent:

```bash
birdclaw --json jobs install-bookmark-export-launchd \
  --program /opt/homebrew/bin/birdclaw
```

Override the calendar time for this installed agent:

```bash
birdclaw --json jobs install-bookmark-export-launchd \
  --hour 4 \
  --minute 15 \
  --program /opt/homebrew/bin/birdclaw
```

The agent runs `jobs export-bookmarks`, uses the same
`~/.birdclaw/locks/bookmark-export.lock` as manual export to prevent overlap,
and appends one audit entry to
`~/.birdclaw/audit/bookmark-export.jsonl`. Installing or loading it does not
immediately export; the first automatic run waits for the next scheduled time.

This job is local-only and needs no X cookies or API credentials. Schedule `jobs sync-bookmarks` separately if the local database must also be refreshed from X.

## Directory layout

```text
bookmark-archive/
  INDEX.md
  accounts/
    <encoded-account-id>/
      2026/
        08/
          <encoded-tweet-id>.md
      unknown-date/
        <encoded-tweet-id>.md
```

Account and tweet IDs are encoded as path segments. The account level prevents the same tweet bookmarked by two accounts from colliding. Tweets without a valid creation date go under `unknown-date` rather than receiving a fabricated date.

Each item file contains controlled frontmatter, rendered tweet text, extracted links, media links, an X source link, and a notes section. Birdclaw records a content hash so unchanged files can be skipped without relying on file timestamps. Media is linked but not downloaded.

`bookmarked_at` can be `null`, especially for archive imports that prove collection membership but do not contain a reliable bookmark time.

## User notes ownership

Write personal notes only between these markers:

```markdown
<!-- birdclaw:user-notes:start -->
Your notes live here.
<!-- birdclaw:user-notes:end -->
```

Birdclaw preserves every byte between one valid start/end marker pair when it updates or fully rebuilds a current item. Content outside that region is managed output and may be replaced.

If either marker is missing, duplicated, or reversed, Birdclaw treats the file as conflicted. It does not overwrite the file. The path and parse error appear under `Unindexed files` in `INDEX.md` and in the export result.

## Permanent retention and index

Export never deletes item files. If a bookmark is later removed from X or from local SQLite, its existing Markdown file remains permanently in the archive. `--full` also does not prune historical files.

The path chosen on first export remains stable. If a later local sync corrects the tweet timestamp into another month, Birdclaw updates the existing file in place and preserves its notes instead of moving or deleting it.

Every run rebuilds `INDEX.md` by scanning `accounts/**/*.md` on disk, not by listing only current database bookmarks. The index therefore remains a panoramic catalog of current and historical exports across accounts and months. It includes account totals, the known date range, newest-first monthly sections, unknown-date entries, and malformed files that could not be indexed.

Because permanent retention is intentional, deleting a historical file is a manual user decision. A deleted file can only be recreated automatically while the corresponding bookmark still exists in the selected account's local collection.

## Suggested workflow

```bash
# Optional: refresh local state from X.
birdclaw sync bookmarks --mode auto --all --refresh --json

# Export immediately when something needs urgent reading.
birdclaw bookmarks export

# Install the independent daily local export.
birdclaw jobs install-bookmark-export-launchd --hour 3 --minute 0

# Build a one-off topic brief when thread synthesis is needed.
birdclaw research "codex" --out ~/research/codex.md
```

## See also

- [Sync](sync.md) — refresh local bookmark state from X
- [Research](research.md) — build a topic-oriented thread brief
- [Jobs](jobs.md) — audit, lock, and launchd details
- [Configuration](configuration.md) — config file and account selection
