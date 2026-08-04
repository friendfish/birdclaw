# Scheduled Digest Recovery, Credentials, and Manual Save Design

## Goal

Make scheduled digest work observable and recoverable across macOS sleep, publish
completed sources without waiting for the whole batch, stop non-interactive jobs
from prompting for Chrome Keychain access, and let users deliberately replace a
Today or 24h archive with a digest they manually regenerated.

The design also exposes each digest's generation timestamp on the Today,
Yesterday, 24h, and Week views.

## Confirmed Failure Modes

The 2026-08-04 jobs did run, but sleep and the current batch-level lock made them
look absent:

- The Today job started at 08:00, the Mac slept at 08:01, and it resumed after
  the lid opened at 08:35. It finished at 08:38.
- The Yesterday job ran from 07:50 to 08:38. Its live process exceeded the
  lock's 45-minute stale threshold, so status stopped reporting the task even
  though it was still generating For You.
- Today's All archive was already on disk at 08:37, but the period-level lock
  caused every Today content-source request to return the generic background
  generation message until the entire batch completed.
- Yesterday's For You archive did not yet exist when the active task was hidden
  by stale-lock detection, so the UI incorrectly reported that no archive
  existed.
- LaunchAgents did not receive `AUTH_TOKEN` and `CT0`. Scheduled Bird sync fell
  back to browser-cookie discovery, which invoked macOS `security` for Chrome
  Safe Storage and caused the password prompt. Interactive runs inherited the
  shell variables and did not use that fallback.

Therefore the empty Today state, the false Yesterday missing-archive state, and
the Keychain prompt are all defects addressed by this change.

## Scope

This change covers:

- scheduled digest execution for `today`, `24h`, `yesterday`, and `week`;
- persistent active-run state, lock ownership, heartbeat, model timeout, and
  final audit state;
- archive status and entry APIs plus Today route presentation;
- visible generation timestamps for all four period views;
- manual replacement of the current day's Today/24h archive after a user-initiated
  refresh;
- X credential management in Config and non-interactive Bird authentication;
- LaunchAgent installation and schedule-update preservation of the credential
  environment path.

The change does not add a general-purpose queue, parallelize the three model
calls, retain versions of manually replaced archives, change schedule times, or
make Yesterday/Week manually generatable.

This design intentionally supersedes the earlier scheduled-digest reliability
design's non-goal of avoiding a persistent job manifest. The incidents above
show that a persistent active-run state is required to distinguish a sleeping or
slow live process from a dead job.

## Architecture

The design separates three concerns:

1. The lock answers only whether a process owns the right to generate a period.
2. A persistent run-state file answers what the owner is currently doing and
   which content sources are usable.
3. The final audit answers how the completed run ended, including source-level
   failures after the active state has been removed.

Archive JSON remains the authoritative published digest. A source becomes
visible as soon as its JSON file has been atomically published; it does not wait
for the other sources or final batch metadata.

## Persistent Run State

Each period uses one state file under the BirdClaw data root, for example:

```text
~/.birdclaw/runs/digest-archive-today.json
```

The state uses a versioned contract:

```ts
type DigestRunPhase = "pre-sync" | "generating" | "finalizing";
type DigestSourceState = "pending" | "running" | "completed" | "failed";

interface DigestArchiveRunStateV1 {
	schemaVersion: 1;
	period: "today" | "24h" | "yesterday" | "week";
	pid: number;
	host: string;
	runDate: string;
	startedAt: string;
	lastHeartbeatAt: string;
	phase: DigestRunPhase;
	currentSource?: "all" | "for_you" | "following";
	totalSources: number;
	sources: Partial<Record<
		"all" | "for_you" | "following",
		{
			state: DigestSourceState;
			attempts: number;
			generatedAt?: string;
			error?: string;
		}
	>>;
}
```

The job writes this state atomically when it acquires the lock, on each phase or
source transition, and at least every 15 seconds while awake. Error strings are
sanitized with the existing sensitive-parameter redaction before persistence or
API exposure.

The source order remains All, Following, For You. After a source's archive JSON
is published, the job marks that source `completed` with `generatedAt`. A failed
source is marked `failed`, and independent later sources still run.

### Lock Ownership and Staleness

The existing period lock remains the mutual-exclusion primitive, but elapsed
time alone no longer makes an owner stale.

For a same-host lock, PID liveness takes precedence over heartbeat age. If the
PID exists, the owner is live even when the Mac slept longer than 45 minutes.
The heartbeat expires after 60 seconds, four missed intervals. The lock and
state may be reclaimed only when the PID is gone and the heartbeat has also
expired. This limits a crashed process to about one minute of recovery delay
without misclassifying a sleeping live process. For a state written by another
host, where local PID checking is not meaningful, heartbeat expiry remains the
recovery signal.

Malformed state never causes an active same-host process to be killed or its
lock to be removed. It produces an unknown-progress active response until the
owner exits or the recovery conditions are met.

### Sleep and Timeout Behavior

launchd continues to provide catch-up behavior for a calendar event missed
during sleep. If the process was already running when sleep began, it resumes on
wake with the same PID and therefore remains the recognized lock owner.

Each model attempt has a 10-minute wall-clock timeout. If sleep spans that
deadline, the timeout aborts the current request shortly after wake and the
existing retry policy starts a fresh attempt. This prevents a half-open network
request from holding the period indefinitely while preserving the current
source-level retry behavior.

In `finally`, the owner stops the heartbeat, writes the final audit entry, and
removes its state and lock. Cleanup verifies ownership before removing either
file so an old process cannot delete a newer run's state.

## Status API and Partial Results

`GET /api/digest-archive-status` returns active runs with the phase, current
source, total source count, per-source states, timestamps, and run date. It also
returns the latest matching final audit summary so the UI can distinguish a
failed source from a date that was never scheduled after active state cleanup.

During a matching active run:

- Today and 24h temporarily read the current run's archive entries instead of
  sending a live generation request.
- Yesterday and Week continue using the existing archive reader.
- A completed selected source is rendered immediately while later sources keep
  generating.
- A pending or running selected source displays accurate progress such as
  `Generating scheduled digest 2/3 - For You` and `This source is still being
  generated.`
- Status, date-list, and selected-entry queries poll every two seconds.
- An explicitly selected older Yesterday or Week date remains a historical
  view and is not labeled as pending because a newer run is active.

When the run ends, the client performs one final status, date-list, and entry
refetch. Already rendered Markdown remains on screen during that transition, so
the route does not flash empty. Today and 24h then return to their normal
live/cache path, whose cache contains the scheduled result.

The UI must not display `No archived...` or `hasn't run` for a date that has a
matching live run. After the run ends, a missing source with a failed audit step
shows a source-specific, sanitized generation failure. Successful sources remain
readable even when the batch is degraded or another source failed.

## Generation Timestamp

All six logical content-source combinations under Today/24h and all archived
Yesterday/Week views display a visible local-time generation timestamp in the
digest status area:

```text
Generated Aug 4, 2026, 8:38 AM
```

Live Today/24h results use `PeriodDigestRunResult.updatedAt`. Archived results
use the archive file's `generatedAt`, already exposed by the entry API as
`updatedAt`. The timestamp updates when the user changes period, source, or
historical date. It describes when the displayed digest was generated, not when
the page loaded or when an archive was manually replaced.

## Manual Today/24h Archive Replacement

The UI presents a Save button in each of these six logical views:

- Today / All
- Today / For You
- Today / Following
- 24h / All
- 24h / For You
- 24h / Following

The button affects only the currently displayed `period + contentSource`. It
never generates or writes either of the other content sources.

### Save Eligibility State Machine

Save is an optional action tied to an explicit manual refresh in the current
page session:

```text
initial scheduled or cached result -> Save disabled
user clicks Refresh               -> Save disabled while generating
manual Refresh completes          -> Save enabled for that exact result
user clicks Save                  -> archive replaced; Saved/disabled
another manual Refresh completes  -> Save enabled for the new result
```

Each of the six combinations tracks eligibility independently. Merely opening
the route, receiving a cached result, receiving a scheduled result, switching
tabs, or reloading the page does not create save eligibility. Eligibility is
associated with the exact completed result's `updatedAt`; it cannot be carried
to a different result, period, or source.

If the user switches away and back within the same mounted page session, the
combination may retain eligibility only while the exact eligible result is still
the displayed result. A browser reload deliberately clears eligibility because
the new session did not initiate that manual generation.

Save remains disabled while a scheduled job owns the same period, while a
stream is incomplete, or when no complete digest result exists.

### Save API and Publication

A dedicated write endpoint accepts only:

- `period`, restricted to `today` or `24h`;
- the current `contentSource`;
- the current generation options needed to identify the server cache, including
  `includeDms`; and
- `expectedUpdatedAt` for optimistic concurrency.

The browser does not submit Markdown, context, or model output. The server reads
the corresponding latest digest from its own cache and requires its timestamp
to equal `expectedUpdatedAt`. A mismatch returns a conflict and instructs the
user to refresh; a concurrent scheduled owner also returns a conflict.

The server writes only the current local date's paths:

```text
<archiveDir>/<runDate>/today-all.{json,md}
<archiveDir>/<runDate>/24h-for_you.{json,md}
```

The actual suffix follows the selected source. Both files are written through
same-directory temporary files. Markdown is renamed first and JSON last; JSON
is the publication marker used by the application. The operation returns only
after both replacements succeed. No old version is retained.

Archive schema v3 records `archiveOrigin: "scheduled" | "manual"` and `savedAt`
without changing the meaning of `generatedAt`. Scheduled entries retain their
batch and sync metadata. Manual entries represent a single digest replacement
and do not claim that the original scheduled batch metadata describes the new
content. Readers remain compatible with schema versions 1 and 2.

A successful manual replacement writes a sanitized audit event. The UI marks
the opportunity Saved and invalidates the matching archive query. A failed or
conflicting save leaves the manual result visible and eligible for retry.

## X Credentials in Config

Config adds an `X Credentials` section with password inputs for `AUTH_TOKEN` and
`CT0`. Both values are required for Save or Replace. After a successful write,
the UI shows only `Configured` and the update time. It never displays, copies,
or receives either stored value.

The section supports:

- Save/Replace credentials;
- Test credentials; and
- Clear credentials.

Credentials are stored at a fixed managed path:

```text
~/.birdclaw/credentials/bird.env
```

The credentials directory is mode `0700` and the file is mode `0600`. Writes
use a same-directory temporary file, set permissions before publication, and
atomically rename it. The parser accepts only literal `AUTH_TOKEN` and `CT0`
assignments; it does not execute or source file contents.

The credentials are never written to `config.json`, a LaunchAgent plist, an
audit log, an error response, or process arguments. `GET` returns only
configured/complete status and update time. POST/DELETE responses also contain
no secret material.

### Bird Execution

BirdClaw's app and scheduled digest paths load the managed credentials before
starting Bird. The scheduled path is explicitly non-interactive:

- both managed values are supplied through the child environment;
- browser-cookie discovery is disabled;
- missing or partial credentials produce a sanitized degraded sync step; and
- no Safari, Chrome, Keychain, or `security` lookup is attempted.

Test Credentials uses the same non-interactive path and a lightweight
authenticated Bird operation. It reports only success or a sanitized failure.

Direct CLI compatibility remains intact: explicit CLI/process credentials may
still be used outside the managed app path. The app and Config test use the
managed credential pair consistently so replacing credentials in Config has an
immediate, predictable effect.

All four digest LaunchAgents receive the fixed credential env path. The
all-period installer must preserve `envFile` for every generated plist, not
only the single-period branch. The digest schedule API must also preserve this
path when it reinstalls jobs after a Config schedule update. Saving schedule
settings therefore cannot silently remove scheduled authentication.

Clearing credentials does not remove archives or cached summaries. Future live
syncs report that X credentials are not configured and continue from local data
where the existing degraded-sync policy permits it.

## Error Handling and Security

- Run-state, audit, archive, and credential writes use atomic JSON/text
  publication patterns appropriate to each file.
- Cleanup and manual replacement re-check lock ownership server-side; disabled
  buttons are not treated as a concurrency guarantee.
- All persisted or returned Bird errors pass through sensitive-value redaction.
- Credential values are compared or passed only in memory and never included in
  telemetry, test snapshots, or thrown error messages.
- A corrupt archive remains a null/unreadable entry and does not block other
  sources. A corrupt run state remains conservatively active while its owner is
  demonstrably alive.
- A failed manual save never clears the displayed digest or consumes the user's
  save opportunity.

## Testing

Focused tests will cover:

- a same-host live PID remains active after the old 45-minute threshold;
- a dead PID plus expired heartbeat is reclaimed, while an alive PID is not;
- heartbeat and phase/source transitions are written and owner-checked cleanup
  removes the state;
- a model attempt times out after 10 minutes and uses the existing retry path;
- Today/24h render a completed source while another source is pending;
- an active Yesterday source never falls through to `No archived`;
- final refetch preserves rendered Markdown and failed final sources use audit
  status;
- all period/source/date changes display the matching generation timestamp;
- each Today/24h source starts with Save disabled;
- only a completed user-triggered Refresh enables Save for the exact result;
- Save replaces only the selected source's JSON and Markdown, then disables;
- a second manual Refresh creates another save opportunity;
- cache timestamp mismatch and active scheduled ownership reject replacement;
- archive readers accept schema versions 1, 2, and 3;
- credential GET/POST/DELETE never return tokens and enforce `0700`/`0600`;
- credential testing and missing-credential scheduled sync never invoke browser
  cookie or Keychain lookup;
- all-period CLI installation and Config schedule updates retain the env path;
  and
- token-shaped values are redacted from errors, audit entries, and logs.

Tests use temporary archive/credential roots and mocked process, transport, and
clock boundaries. They do not call OpenAI, X, a browser profile, or the real
macOS Keychain.

After focused tests, run `pnpm run check`, the full test suite, the production
build, and `git diff --check`.

## Acceptance Criteria

The change is accepted when:

1. A scheduled run spanning sleep remains visible as active and either resumes
   or times out and retries after wake.
2. Every completed source becomes readable immediately, without waiting for the
   batch lock to be released.
3. A matching active run never produces a false missing-archive message.
4. Today, Yesterday, 24h, and Week show the displayed digest's generation time.
5. Save is available independently in the six Today/24h source combinations
   only after a manual Refresh, and replaces only that combination's current-day
   archive.
6. Config-managed credentials authenticate scheduled Bird sync without Chrome
   Safe Storage or any other interactive Keychain prompt.
7. Schedule edits and all-period LaunchAgent installation retain credential
   configuration without exposing the values.
