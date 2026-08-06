# PR 51 Second Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove the remaining cross-process, lease-loss, freshness scheduling, API, and UI correctness gaps identified in the second review of PR #51.

**Architecture:** Keep one owner per Today/24h period and make joiners read-only observers by recording their provenance in independent append-only event files. Model generation is controlled by an owner AbortController tied to lease health, while bounded completion waits distinguish terminal, superseded, and abandoned runs. Freshness uses deterministic version-derived attempt tokens, a cross-process scheduler lease, persisted launch execution settings, and one atomic reconciliation path shared by Config, launchd, and batch finalization.

**Tech Stack:** TypeScript, Effect, TanStack Router/Query, Vitest, Node filesystem leases, launchd.

---

### Task 1: Bound Join Waiting And Remove Joiner State Writes

**Files:**
- Modify: `src/lib/period-digest-orchestrator.ts`
- Modify: `src/lib/period-digest-orchestrator.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving that a joiner returns an already-terminal locked run, rejects when its run ID is superseded, times out when an abandoned run never changes, and records joined provenance without rewriting the owner state file.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm test src/lib/period-digest-orchestrator.test.ts`

Expected: failures for unbounded waiting, terminal-lock collision, and cross-process-safe join recording.

- [x] **Step 3: Implement minimal bounded observation**

Replace `waitForRunCompletion` with a bounded observer that checks the expected run ID, run age, and lock liveness. Treat a terminal state found while the owner still holds the lock as a completed collision rather than an error. Store join events separately from owner state, for example:

```ts
await writeJoinEvent({ period, runId, event, at });
```

Owner state writes remain owner-token guarded and never accept read-modify-write data from joiner processes.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test src/lib/period-digest-orchestrator.test.ts`

Expected: all orchestrator tests pass.

### Task 2: Abort On Heartbeat Or Lease Loss

**Files:**
- Modify: `src/lib/period-digest-orchestrator.ts`
- Modify: `src/lib/period-digest-orchestrator.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving that a rejected heartbeat is handled, a false lease heartbeat aborts an in-flight generation signal, no later source starts, and no result publishes after ownership loss.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm test src/lib/period-digest-orchestrator.test.ts`

Expected: lease-loss tests fail because the current source loop continues.

- [x] **Step 3: Implement one owner cancellation path**

Create one owner `AbortController`, combine its signal with the per-call timeout signal, and route heartbeat rejection/false ownership through a single batch-level ownership error. A lease error must bypass the per-source failure continuation path.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test src/lib/period-digest-orchestrator.test.ts`

Expected: all orchestrator tests pass without unhandled rejections.

### Task 3: Make Freshness Tokens And Installation Cross-Process Safe

**Files:**
- Modify: `src/lib/period-digest-freshness.ts`
- Modify: `src/lib/period-digest-freshness.test.ts`
- Modify: `src/lib/config.ts`
- Modify: `src/lib/config.test.ts`
- Modify: `src/lib/digest-archive-job.ts`
- Modify: `src/routes/api/digest-schedule.tsx`
- Modify: `src/routes/api/digest-schedule.test.ts`

- [x] **Step 1: Write failing freshness tests**

Assert that unchanged source versions/configuration produce the same token, consumed tokens are not rearmed by reconciliation, partial-success finalization installs one valid future opportunity without an immediate retry loop, concurrent reconcilers use a filesystem scheduler lease, and the dynamic agent receives the configured `program` and `envFile`.

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm test src/lib/period-digest-freshness.test.ts src/routes/api/digest-schedule.test.ts`

Expected: failures show random tokens, missing execution settings, and process-local-only scheduling.

- [x] **Step 3: Implement deterministic token semantics**

Derive the attempt token from period, all source version IDs or scheduled fallback, freshness seconds, and due date. Preserve a consumed token when reconciliation observes the same identity. When a degraded run publishes any source, close the opportunity that started the run and calculate the next deadline without rearming an already-failed stale source immediately.

- [x] **Step 4: Implement scheduler lease and execution settings**

Persist the digest launch execution settings used by fixed agents and pass them to dynamic agents:

```ts
buildPeriodDigestFreshnessLaunchAgent({
  period,
  fireAt,
  attemptToken,
  program,
  envFile,
});
```

Guard state, plist replacement, and launchctl update with a period-scoped cross-process scheduler lease. Remove duplicate minute rounding.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm test src/lib/period-digest-freshness.test.ts src/routes/api/digest-schedule.test.ts`

Expected: all freshness and schedule tests pass.

### Task 4: Harden Routes, Migration, Polling, And Compatibility CLI

**Files:**
- Modify: `src/routes/api/period-digest.tsx`
- Create: `src/routes/api/period-digest-runs.tsx`
- Modify: `src/routes/api/period-digest-freshness.tsx`
- Modify: `src/routes/api/digest-schedule.tsx`
- Modify: `src/routes/api/period-digest-metadata.tsx`
- Modify: `src/components/usePeriodDigestMetadata.ts`
- Modify: `src/cli/register-jobs.ts`
- Modify: matching route, hook, and CLI tests

- [x] **Step 1: Write failing route, migration, hook, and CLI tests**

Cover typed promise failures, POST run creation, one migration scan per process, 30-second idle polling with 3-second active polling, and explicit rejection of archive/backfill-only flags for Today/24h.

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm test src/routes/api/period-digest.test.ts src/routes/api/period-digest-metadata.test.ts src/routes/api/period-digest-freshness.test.ts src/cli/register-jobs.test.ts`

Expected: tests fail on GET side effects, repeated migration, and ignored options.

- [x] **Step 3: Implement the API and client changes**

Move Today/24h run creation to `POST /api/period-digest-runs`, keep only a deliberate compatibility shim if required, use `Effect.tryPromise` for rejecting promises, guard migration with a shared one-time Promise, and poll metadata at 30 seconds while idle and 3 seconds while generating.

- [x] **Step 4: Report incompatible legacy command options**

For `run-digest-archive --period today|24h`, report explicitly supplied archive, DM, source-selection, backfill, custom-log, and retry flags as ignored while preserving compatibility with already-installed launchd plists; continue applying account, managed credentials, and live-sync controls.

- [x] **Step 5: Run focused tests and verify GREEN**

Run the focused command from Step 2 and confirm all selected tests pass.

### Task 5: Correct Migration Provenance And Documentation

**Files:**
- Modify: `src/lib/period-digest-current-store.ts`
- Modify: `src/lib/period-digest-current-store.test.ts`
- Modify: `docs/jobs.md`
- Modify: `docs/superpowers/specs/2026-08-06-today-24h-digest-orchestration-design.md` only if remediation clarifies degraded freshness semantics

- [x] **Step 1: Write a failing provenance test**

Assert that migrated legacy results record unknown input limits rather than fabricated `2500/12` values.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm test src/lib/period-digest-current-store.test.ts`

Expected: migration provenance assertion fails.

- [x] **Step 3: Implement an explicit legacy-unknown representation**

Update the persisted schema and parser so current results retain exact numeric limits while migrated legacy results use an explicit unknown marker.

- [x] **Step 4: Update jobs documentation**

Document `jobs run-period-digest`, fixed versus freshness agents, execution environment reuse, no Today/24h archives, collision semantics, timeout behavior, and the compatibility command's rejected flags.

- [x] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm test src/lib/period-digest-current-store.test.ts`

Expected: all current-store tests pass.

### Task 6: Full Verification And PR Update

**Files:**
- Review all modified files

- [x] **Step 1: Run formatting and static checks**

Run: `pnpm run check`

Expected: exit 0.

- [x] **Step 2: Run the complete test suite**

Run: `pnpm test`

Expected: all tests pass; production-server tests may require permission to bind localhost.

- [x] **Step 3: Run coverage and build**

Run: `pnpm coverage`

Run: `pnpm run build`

Expected: coverage thresholds and build pass.

- [x] **Step 4: Review the final diff**

Confirm every accepted review item has an implementation and regression test, no unrelated files changed, and the worktree is clean after commit.

- [x] **Step 5: Commit, push, and update PR #51**

Commit the verified remediation, push `codex/issue-50-digest-orchestration`, and add a PR comment mapping each review item to its fix and tests.
