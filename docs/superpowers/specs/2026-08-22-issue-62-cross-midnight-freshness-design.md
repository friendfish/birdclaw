# Issue #62: Cross-Midnight Freshness Baseline Design

## Document Status

- Date: 2026-08-22
- Issue: [#62](https://github.com/friendfish/birdclaw/issues/62)
- Selected approach: clamp every source freshness base to the current day's fixed schedule
- Scope: Today/24h freshness deadline calculation and regression coverage

## Summary

Today and 24h freshness are intra-day update mechanisms. A freshness attempt from
the previous day must not establish the first refresh cycle of a new day, even if
some of its source generations finish after midnight. The fixed Today/24h task
owns that daily boundary.

For each unsuppressed source, the scheduler will calculate:

```text
effectiveBase = max(scheduledBase, valid same-day generatedAt)
sourceDeadline = effectiveBase + freshnessSeconds
```

`scheduledBase` is the configured fixed time on the local calendar day represented
by `now`, such as 07:00 for Today or 07:30 for 24h. Missing, invalid, previous-day,
and same-day-but-before-schedule generation times all use `scheduledBase`.

The overall deadline remains the earliest deadline among unsuppressed sources and
must remain on the current local day. Existing attempt tokens, source suppression,
retry state, page recovery, cross-process locking, and launchd installation rules
remain unchanged.

## Required Behavior

### Daily boundary

- A previous-day run that finishes a source after midnight cannot schedule a
  freshness attempt before the new day's fixed digest task.
- Before the fixed time, the earliest possible freshness deadline is
  `scheduledBase + freshnessSeconds`, not `generatedAt + freshnessSeconds`.
- A persisted previous-day `dueAt` is still rejected by
  `consumePeriodDigestFreshnessAttempt` with `cross-day`.

### Same-day freshness

- A source generated at or after the fixed time uses its actual `generatedAt`.
- When the fixed task publishes new versions, its source identities produce a new
  attempt token and reconciliation schedules the next freshness from the actual
  successful generation times.
- A manual generation before the fixed time does not postpone or replace the fixed
  daily boundary. Its freshness base is clamped to `scheduledBase`.
- A manual generation after the fixed time behaves like any other same-day result
  and uses its actual generation time.

### Missed and failed fixed tasks

- If the machine sleeps through the fixed time, the fallback deadline remains
  `scheduledBase + freshnessSeconds`. Existing overdue handling may schedule the
  launchd attempt for the next eligible minute or allow the page/CLI path to run it.
- If the fixed task fails every source, the baseline freshness attempt remains
  eligible at `scheduledBase + freshnessSeconds`, preserving same-day recovery.
- If the fixed task publishes some sources and fails others, existing source
  suppression excludes the failed source versions. Successful sources use their
  post-schedule generation times and continue freshness normally.

## Implementation

Change `calculatePeriodDigestFreshnessDeadline` in
`src/lib/period-digest-freshness.ts`. A parsed `generatedAt` is eligible only when
it is on the same local day as `now` and is not earlier than `scheduledBase`.
Otherwise that source uses `scheduledBase`.

No persisted state field or schema version changes are needed. The attempt token
continues to include period, freshness configuration, schedule, current source
identities, and suppression identities. A cross-midnight publication therefore
retains its content identity while receiving the correct daily time floor; a
later fixed-task publication still changes the identity and replaces the attempt.

No orchestrator changes are planned. Its existing behavior already reconciles
after at least one source publishes, suppresses failed source identities, and
leaves the prior attempt available when every source fails.

## Error Handling and Compatibility

- Invalid timestamps continue to use the fixed schedule fallback.
- Deadlines that cross local midnight continue to return `null`, producing a
  disabled freshness state.
- Existing persisted states remain readable because no schema changes are made.
- Token mismatch, already-running, retryable, page recovery, and launchd retry
  behavior are outside this change and must remain covered by the existing suite.
- Local-time comparison remains consistent with the current scheduler and launchd
  calendar configuration; this change does not introduce UTC day boundaries.

## Testing

Add focused regression cases in `src/lib/period-digest-freshness.test.ts`:

1. A previous-day run whose sources complete shortly after midnight uses the 24h
   07:30 baseline and cannot become due at 04:01/04:07.
2. A pre-schedule manual result for Today uses the 07:00 baseline.
3. Reconciliation after a missed fixed time retains the fixed-time fallback and
   becomes recoverable once `scheduledBase + freshnessSeconds` is due.
4. A fixed task with no successful replacement leaves the baseline deadline
   available for same-day recovery.
5. Post-schedule fixed-task results use their actual per-source generation times.
6. A failed source is suppressed while successful post-schedule sources determine
   the next deadline.
7. Existing cross-day consumption and deadline-disable tests continue to pass.

Run the focused freshness suite first, then the complete test suite and repository
quality checks.

## Non-Goals

- Persisting a daily cycle or scheduled-run identity.
- Changing fixed Today/24h launchd schedules.
- Allowing a previous-day freshness attempt to execute on a new day.
- Changing freshness retry counts, backoff, page recovery, or run locking.
- Guaranteeing digest generation while the machine remains asleep or offline.
