# PR 48 Review Remediation Design

## Goal

Close the three blocking findings in PR #48 without weakening the managed X
credential boundary or breaking existing scheduled digest installations. Also
remove the avoidable full audit-log parse performed by each status poll.

## Compatibility Boundary

`--env-path` keeps its existing launchd contract: it identifies a user-managed
shell environment file that is sourced by the launch wrapper. Existing files may
contain `export` assignments and variables other than Bird cookies, including
`OPENAI_API_KEY`.

Managed X credentials use a separate `--bird-credentials-path` option. That file
is parsed as inert data and must contain exactly `AUTH_TOKEN` and `CT0`; it is
never sourced by a shell. Config-created digest LaunchAgents use this new option,
while CLI callers can still combine a legacy `--env-path` with a managed Bird
credential path when needed.

The digest run command accepts only `--bird-credentials-path` for strict parsing.
The install command accepts both options because it owns the launch wrapper.

## Credential Precedence

Bird subprocess environments are composed in this order:

1. inherited process environment;
2. credentials saved in Config;
3. explicit per-command credentials.

This makes Config authoritative over stale shell cookies while preserving an
explicit CLI credential file as the highest-priority override. The Config test
endpoint therefore tests the saved pair, not an inherited pair.

## Scheduled Lock Lease

The digest lock is a renewable lease rather than a one-time PID marker. Its
validity is evaluated as follows:

- `startedAt` must be younger than the job-specific absolute maximum;
- a current-host owner remains active while its PID is alive, including across a
  system sleep that pauses the file heartbeat;
- a dead current-host PID is stale immediately;
- remote-host and legacy owners remain active only while their file heartbeat is
  newer than the stale interval.

The existing digest run-state heartbeat also refreshes the owned lock every 15
seconds. Refresh and release operations verify `ownerId`; a previous owner cannot
refresh a replacement lock. The digest's six-hour cap prevents a reused PID or a
runaway heartbeat from preserving a lock indefinitely.

Other scheduled jobs retain their configured stale intervals for remote and legacy
owners, and now also reclaim a dead current-host PID immediately. A live
current-host account-sync owner is bounded by its one-hour maximum; bookmark-sync
and digest owners retain the six-hour maximum.

## Status Polling

The status reader caches parsed audit results by audit path, file size, and mtime.
Unchanged polls reuse the parsed four-period snapshot. A changed or replaced file
invalidates the cache, and reverse scanning stops after the latest record for all
four periods has been found.

## Scheduled Cache Identity

Today and 24h discover a completed scheduled result through the same latest
digest cache used by the live page. The page and scheduled archive job therefore
share the `maxTweets=5000` and `maxLinks=20` identity values. If these values
diverge, the scheduled run still writes its archive successfully but the page
looks up a different cache row and can display an older live result or generate
again when opened.

## Error Handling

- A missing strict credential file produces no explicit Bird override, so the job
  can continue through the existing degraded/local-data path and use the file on
  a later run after Config creates it. Invalid contents and file I/O failures are
  reported distinctly, written to the digest audit log, and exposed as a sanitized
  batch-level error in the Today UI before the job fails.
- A lock heartbeat that reports lost ownership interrupts the digest workflow and
  aborts the in-flight model request before writing a failed audit entry. Run-state
  cleanup remains owner-checked.
- Audit stat/read failures return an empty snapshot and do not retain stale cached
  data for a missing file.

## Testing

- LaunchAgent tests cover legacy shell env sourcing and shell-free managed Bird
  credential arguments independently and together.
- CLI and Config schedule tests cover the new option wiring.
- Credential tests prove managed-over-process and explicit-over-managed order.
- Lock tests prove heartbeat renewal, sleep-safe live-PID retention, dead-PID
  reclamation, per-job absolute expiry, owner-safe refresh, lost-lock interruption,
  and in-flight request cancellation.
- Status tests prove unchanged audit logs are read once, changed logs invalidate
  the cache, and sanitized batch failures reach the Today UI.
- Digest archive tests prove scheduled generation uses the same input limits as
  the Today page's latest-cache identity.
