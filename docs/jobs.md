---
title: Jobs
description: "Scheduler-friendly sync and digest generation with launchd integration, audit logs, and lock files."
---

# Jobs

`birdclaw jobs` provides scheduler-friendly sync, local export, and digest runs:
short defaults, JSONL audit logs, lock files to prevent overlap, and launchd
installers for macOS.

## `jobs sync-account`

```bash
birdclaw --json jobs sync-account --account acct_openclaw --limit 100 --max-pages 3 --refresh --allow-bird-account
```

What it does:

- refreshes home timeline, mentions, mention threads, likes, bookmarks, and DMs for one account
- uses `bird` for home and mentions; DMs can use `auto`/`xurl` for accepted-message imports, while message-request state still needs `bird`
- appends one JSONL audit entry per run to `~/.birdclaw/audit/account-sync.jsonl`
- records each step independently so one rate-limited surface does not hide the others
- runs backup auto-sync after the scheduled refresh when enabled

Install the LaunchAgent:

```bash
birdclaw --json jobs install-account-launchd --account acct_openclaw --program /opt/homebrew/bin/birdclaw --env-path ~/.config/bird/openclaw.env --allow-bird-account
```

The default interval is 1,800 seconds (30 minutes). Use `--steps timeline,mentions,dms` for a narrower job, or `--env-path ~/.config/bird/openclaw.env` when launchd needs account cookies. Pass `--allow-bird-account` only when the sourced cookies match `--account`; without it, Bird-backed timeline, mentions, and `--mode bird` DM steps refuse non-default account writes.

The account-sync lock has a one-hour absolute lifetime. A stuck run therefore
cannot block more than two normal 30-minute schedule windows, even if its process
is still alive.

## `jobs sync-bookmarks`

```bash
birdclaw --json jobs sync-bookmarks --mode auto --limit 100 --max-pages 5 --refresh
```

What it does:

- runs a live bookmark refresh with scheduler-friendly defaults
- appends one JSONL audit entry per run
- exits non-zero when the sync failed, so a scheduler can detect and retry
- uses `~/.birdclaw/locks/bookmarks-sync.lock` to skip overlapping runs (records `already-running` instead of crashing)

Audit entries include:

- host
- start / end timestamps and duration
- before / after bookmark counts
- transport source (`xurl` / `bird`)
- fetched count
- backup-sync result (when `backup.autoSync` is enabled)
- error message on failure

The default audit log path:

```text
~/.birdclaw/audit/bookmarks-sync.jsonl
```

Inspect recent runs:

```bash
tail -n 5 ~/.birdclaw/audit/bookmarks-sync.jsonl | jq .
```

After a successful refresh, the job runs the normal backup auto-sync path. If `~/.birdclaw/config.json` has `backup.autoSync` enabled, the changed local data is merged into the configured Git backup repo, committed, and pushed. The audit entry records that backup result so scheduled runs are inspectable later.

## `jobs install-bookmarks-launchd`

macOS only. Writes a LaunchAgent plist that runs `jobs sync-bookmarks` every 3 hours.

```bash
birdclaw --json jobs install-bookmarks-launchd --program /opt/homebrew/bin/birdclaw
```

What it writes:

- `~/Library/LaunchAgents/com.steipete.birdclaw.bookmarks-sync.plist`
- runs at load, then every 10,800 seconds (3 hours)
- writes audit log to `~/.birdclaw/audit/bookmarks-sync.jsonl`
- writes stdout/stderr to `~/.birdclaw/logs/bookmarks-sync.*.log`
- uses `launchctl load -w` unless `--no-load` is passed

Flags:

- `--program <path>` — absolute path to the `birdclaw` executable on this machine (Homebrew, npm global, or source build)
- `--env-path <path>` — source an export-only shell env file inside the scheduled process
- `--no-load` — write the plist but do not load it; useful when you want to inspect first
- `--all` — pass `--all` to the underlying sync, fetching every retrievable page each run (default caps at 5 pages)

### Env files for launchd

When `bird` is the active transport for bookmarks, it usually needs `AUTH_TOKEN` and `CT0` cookies that come from a logged-in browser session. launchd does not see your interactive shell environment, so the scheduled process will fail unless you provide them.

The recommended pattern:

```bash
mkdir -p ~/.config/bird
chmod 700 ~/.config/bird
cat > ~/.config/bird/env.sh <<'SH'
export AUTH_TOKEN="..."
export CT0="..."
SH
chmod 600 ~/.config/bird/env.sh

birdclaw --json jobs install-bookmarks-launchd \
  --program /opt/homebrew/bin/birdclaw \
  --env-path ~/.config/bird/env.sh
```

The plist sources that file inside the scheduled process. The cookies stay on your machine, in your home directory, with mode `0600`. They are never written into the plist itself.

## Daily bookmark Markdown export

Bookmark sync and bookmark export are separate jobs. `jobs sync-bookmarks`
contacts X and updates SQLite; `jobs export-bookmarks` reads SQLite and updates
the permanent Markdown archive without any network request:

```bash
birdclaw --json jobs export-bookmarks
birdclaw --json jobs export-bookmarks --account acct_primary --archive-dir ~/Documents/bookmarks --full
```

Each run appends a JSONL entry to:

```text
~/.birdclaw/audit/bookmark-export.jsonl
```

The entry includes host and timing metadata, the selected account/directory,
the full export result, and any error. The lock at
`~/.birdclaw/locks/bookmark-export.lock` is shared with the manual
`bookmarks export` command. It prevents overlapping exports and logs an
`already-running` skip. A partial export with conflicts exits non-zero but keeps
every conflicting source file untouched.

Install the daily macOS LaunchAgent:

```bash
birdclaw --json jobs install-bookmark-export-launchd \
  --program /opt/homebrew/bin/birdclaw
```

The calendar time comes from `bookmarks.exportSchedule` and defaults to 03:00
local time. `--hour 4 --minute 15` overrides it for this agent. Installation
does not run the exporter immediately: the plist uses `RunAtLoad=false` and
waits for the next calendar trigger.

The installer writes:

- `~/Library/LaunchAgents/com.steipete.birdclaw.bookmark-export.plist`
- `~/.birdclaw/logs/bookmark-export.out.log`
- `~/.birdclaw/logs/bookmark-export.err.log`

No credential or env file is required for the export itself. Use `--env-path`
only when the Birdclaw executable needs other process configuration. The
archive directory defaults to `bookmarks.archiveDir`, then
`~/.birdclaw/bookmark-archive`; an explicit `--archive-dir` is stored as an
absolute launchd argument.

See [Bookmark Markdown Archive](bookmark-archive.md) for permanent retention,
the protected user-notes region, and `INDEX.md` behavior.

## Scheduled digests

The launchd installer creates independent Today, 24h, Yesterday, and Week
agents. Today/24h publish persistent current results; Yesterday/Week write dated
Markdown and JSON archives:

```bash
birdclaw --json jobs install-digest-archive-launchd \
  --period all \
  --program /opt/homebrew/bin/birdclaw \
  --bird-credentials-path ~/.birdclaw/credentials/bird.env
```

The Config page uses the same managed credential path automatically. This file
is inert data rather than a shell script: it must contain exactly these two
assignments, without `export` or extra keys:

```text
AUTH_TOKEN=...
CT0=...
```

`--bird-credentials-path <path>` passes the strict credential path to Birdclaw
without putting cookie values in the plist or invoking a shell. An invalid
existing file fails the command instead of silently falling back and records the
failure in the digest audit log. An unreadable path is reported separately from
invalid contents. A missing managed file leaves the explicit override unset,
allowing the scheduled digest to continue from local data and pick up credentials
after Config creates it.

`--env-path <path>` remains the backward-compatible launch environment option.
It sources a trusted shell file and can carry variables such as
`OPENAI_API_KEY`; it is not parsed as the managed credential file. The install
command accepts both options when a scheduled digest needs a general environment
file plus a separate strict Bird credential file.

### Today and 24h current digests

`jobs run-period-digest` generates one Today or 24h batch. A batch refreshes the
information sources once, freezes the three contexts, and generates All,
Following, and For You sequentially. Each source is published atomically as it
finishes. Existing content remains visible while a replacement is running or if
one source fails.

```bash
birdclaw --json jobs run-period-digest \
  --period today \
  --trigger manual \
  --origin cli \
  --requested-source for_you
```

A manual owner generates `--requested-source` first. Fixed scheduled and
freshness owners use All, Following, then For You. Requests that collide for the
same period join the active batch; they do not start a second batch or queue a
follow-up run. The run state records both the owner trigger and each joining
trigger with its origin.

Today/24h do not create dated archive files and have no Save action. Their six
logical pages are persistent latest-success values in the local database. Older
Today/24h archive files are left untouched for manual access, but the app no
longer reads or replaces them. Yesterday/Week remain the dated sources for
longer-term analysis.

The compatibility command
`jobs run-digest-archive --period today|24h` delegates to the same current-digest
orchestrator and reports `archived:false`. It reports archive-only or backfill
flags in `ignoredOptions` instead of silently ignoring them: `--include-dms`,
`--content-sources`,
`--archive-dir`, `--retries`, `--retry-delay-seconds`, `--log`, `--since`,
`--until`, and `--run-date`. Use `jobs run-period-digest` for new integrations.

### Fixed and freshness agents

Today and 24h each have two launchd paths:

- the fixed calendar agent starts the configured morning batch;
- a one-shot freshness agent wakes at the earliest same-day
  `generatedAt + freshness` deadline across the three source pages.

Freshness defaults to 12 hours and is configurable from 1 to 24 hours in Config.
It never schedules across the local calendar-day boundary. Publishing a new
source version or changing the setting recalculates the deadline. A one-shot
attempt token prevents the same stale version from creating a retry loop.

If a batch is partially successful, successful pages get new deadlines. A
failed page's unchanged version is suppressed for that consumed freshness
opportunity; it becomes eligible again after a manual/fixed run publishes a new
version or the freshness setting changes. This preserves automatic scheduling
without immediately rerunning the same failed work.

If all three sources fail, that freshness opportunity remains consumed and no
additional automatic freshness run is scheduled for those unchanged versions on
the same day. A manual refresh or the next fixed scheduled run can retry them.

The dynamic freshness agent reuses the `--program` and `--env-path` saved when
the fixed digest agents are installed, so Homebrew/npm executable paths and
variables such as `OPENAI_API_KEY` remain available. Saving Config reinstalls the
fixed agents and reconciles the one-shot agents. The page also performs a
token-guarded stale fallback, but normal freshness generation does not depend on
opening the page.

Credential precedence for Bird subprocesses is inherited process environment,
then Config-managed credentials, then an explicit strict credential file. Each
digest lock is renewed by a heartbeat while the job runs and has a six-hour
absolute lifetime, so a PID reused after reboot cannot preserve an old lock
indefinitely. During system sleep the heartbeat pauses; on wake, a live PID on
the current host keeps its lock until heartbeats resume. A dead local PID is
reclaimed immediately, and an expired remote or legacy lock is reclaimed by its
stale interval. Losing ownership during a run aborts the remaining work and writes
a failed audit entry.

Batch failures that occur before any content source starts, including credential
file and lock-ownership failures, are surfaced on the Today page from the latest
scheduled run instead of appearing as a missing archive.

Scheduled Today and 24h generation uses the same tweet and link input limits as
the corresponding page; Yesterday and Week retain the archive job's lower
defaults. Page requests and scheduled jobs also share the same language
precedence (explicit option, environment, then Config).

## Useful checks

After install:

```bash
launchctl print gui/$(id -u)/com.steipete.birdclaw.bookmarks-sync
launchctl kickstart -k gui/$(id -u)/com.steipete.birdclaw.bookmarks-sync
tail -n 1 ~/.birdclaw/audit/bookmarks-sync.jsonl | jq .

launchctl print gui/$(id -u)/com.steipete.birdclaw.bookmark-export
launchctl kickstart -k gui/$(id -u)/com.steipete.birdclaw.bookmark-export
tail -n 1 ~/.birdclaw/audit/bookmark-export.jsonl | jq .
```

`kickstart -k` re-runs the job immediately, which is the fastest way to confirm cookies and config work end-to-end.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.steipete.birdclaw.bookmarks-sync
rm ~/Library/LaunchAgents/com.steipete.birdclaw.bookmarks-sync.plist

launchctl bootout gui/$(id -u)/com.steipete.birdclaw.bookmark-export
rm ~/Library/LaunchAgents/com.steipete.birdclaw.bookmark-export.plist
```

The audit log and lock file are kept by design — remove them by hand if you really want them gone.

## Linux scheduling

Linux is not yet a first-class target for `jobs install-*`. For now, run
`jobs sync-bookmarks` and/or `jobs export-bookmarks` from `cron` or a `systemd`
user timer. The audit/lock semantics are platform-agnostic.

Example crontab:

```text
0 */3 * * * /usr/local/bin/birdclaw --json jobs sync-bookmarks --mode auto --max-pages 5 --refresh >> ~/.birdclaw/logs/cron.log 2>&1
0 3 * * * /usr/local/bin/birdclaw --json jobs export-bookmarks >> ~/.birdclaw/logs/bookmark-export-cron.log 2>&1
```

## See also

- [Sync](sync.md) — manual sync flow with the same flags
- [Bookmark Markdown Archive](bookmark-archive.md) — local export layout and ownership rules
- [Backup](backup.md) — the backup auto-sync path that runs after each scheduled bookmark refresh
- [Configuration](configuration.md) — `backup.autoSync` and `BIRDCLAW_BACKUP_AUTO_SYNC`
