# Today/24h Digest Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Today/24h persistent current views whose scheduled, freshness, and manual triggers join one server-owned batch while old successful content remains visible until an atomic replacement succeeds.

**Architecture:** Introduce a stable latest-result store and a cross-process period orchestrator for Today/24h. Each batch acquires one period lease, records trigger/origin provenance, pre-syncs once, freezes all three source contexts, generates sources sequentially, and atomically publishes each successful result. Fixed launchd agents and dynamic freshness agents enter the same orchestrator; Yesterday/Week keep the existing archive job.

**Tech Stack:** TypeScript, Effect, SQLite `sync_cache`, TanStack Router/Query, React, Zod, Vitest/Testing Library, Node filesystem/process APIs, launchd.

---

## File Map

**New focused modules**

- `src/lib/period-digest-current-store.ts`: stable Today/24h latest keys, versioned values, atomic publication, and legacy latest-row migration.
- `src/lib/period-digest-current-store.test.ts`: stable identity, read/write, corrupt-row, and migration tests.
- `src/lib/period-digest-orchestrator.ts`: trigger normalization, cross-process single-flight lease, run state, one pre-sync, frozen contexts, sequential generation, and per-source publication.
- `src/lib/period-digest-orchestrator.test.ts`: collision, source ordering, partial success, failure retention, trigger provenance, and disconnect-independence tests.
- `src/lib/period-digest-freshness.ts`: 1-24 hour freshness policy, same-day due-time calculation, attempt tokens, one-shot launchd agent construction, and reconciliation.
- `src/lib/period-digest-freshness.test.ts`: due-time, no-cross-day, minute rounding, stale-token, restart reconciliation, and install-failure tests.

**Existing files with scoped changes**

- `src/lib/period-digest.ts` and `.test.ts`: expose context freezing and generation from a supplied context without using parameter-derived latest identity; keep prompt-playground behavior intact.
- `src/lib/digest-archive-job.ts` and `.test.ts`: route Today/24h scheduled runs to the orchestrator and retain archive writes only for Yesterday/Week.
- `src/lib/config.ts` and `.test.ts`: default 12-hour freshness and validated Today/24h config.
- `src/lib/launchd.ts` and `.test.ts`: atomic serialized install/update support for dynamic one-shot agents.
- `src/cli/register-jobs.ts` and `src/cli.test.ts`: add orchestrator trigger/origin/attempt-token inputs and preserve archived-period commands.
- `src/routes/api/period-digest.tsx` and `.test.ts`: make Refresh enqueue/join a manual batch and return server-owned progress rather than owning the model stream.
- `src/routes/api/period-digest-metadata.tsx` and `.test.ts`: always return latest successful content plus independent run state, even when stale or generating.
- `src/routes/api/digest-schedule.tsx` and `.test.ts`: read/write freshness hours, expose scheduler status, and reconcile fixed/dynamic agents.
- `src/routes/api/digest-archive-dates.tsx`, `src/routes/api/digest-archive-entry.tsx`, and tests: restrict archive reads to Yesterday/Week without silent period coercion.
- `src/routes/api/digest-archive-save.tsx` and `.test.ts`: remove the obsolete Today/24h Save endpoint.
- `src/components/usePeriodDigestMetadata.ts`: validate the latest-result/run-state response and poll while a batch is active.
- `src/components/useReadOnlyDigest.ts`: use archives only for Yesterday/Week.
- `src/routes/today.tsx` and `.test.tsx`: retain content during refresh, show generated time, remove Today/24h Save and DM controls, and present independent generation status.
- `src/routes/config.tsx` and `.test.tsx`: add Today/24h freshness controls and scheduler health.
- `src/routeTree.gen.ts`: regenerate after route removal/contract changes.

### Task 1: Add the Stable Current-Digest Store

**Files:**
- Create: `src/lib/period-digest-current-store.ts`
- Create: `src/lib/period-digest-current-store.test.ts`
- Modify: `src/lib/period-digest.ts`
- Test: `src/lib/period-digest.test.ts`

- [x] Write failing tests proving the lookup key is exactly `period-digest-current:v1:<period>:<source>` and is unaffected by model, prompt, language, limits, or DM options.
- [x] Add failing tests for versioned atomic publication and reading all fields required to render/explain a result.
- [x] Add failing migration tests that scan frozen legacy `period-digest-latest:*` labels, choose the newest valid Today/24h row per source, write the stable key once, and ignore corrupt/incompatible rows.
- [x] Run `pnpm test -- src/lib/period-digest-current-store.test.ts src/lib/period-digest.test.ts` and confirm RED.
- [x] Implement `CurrentPeriodDigestV1`, stable key helpers, read/publish APIs, and idempotent read-on-miss migration using injected SQLite/runtime dependencies.
- [x] Keep legacy generation-cache reads for compatibility, but stop using parameter-rich latest keys as the Today/24h page identity.
- [x] Re-run the focused tests and confirm GREEN.

### Task 2: Build the Cross-Process Period Orchestrator

**Files:**
- Create: `src/lib/period-digest-orchestrator.ts`
- Create: `src/lib/period-digest-orchestrator.test.ts`
- Modify: `src/lib/period-digest.ts`
- Test: `src/lib/period-digest.test.ts`

- [x] Write failing tests for `scheduled | freshness | manual` triggers joining one active Today/24h run with no queued rerun.
- [x] Assert provenance is paired: `startedBy: { trigger, origin }` and `joinedBy: Array<{ trigger, origin, at }>` where origin is `launchd | page | cli`.
- [x] Write failing tests for default order `all -> following -> for_you`, manual requested-source priority, and a joiner being unable to reorder an active run.
- [x] Write failing tests proving one pre-sync, three contexts frozen after that sync, sequential model calls, and per-source publication immediately after each success.
- [x] Write failing tests proving a failed source leaves its prior stored version untouched, later sources continue, and a failed batch never empties any page.
- [x] Run the focused tests and confirm RED.
- [x] Implement a period-scoped owner-token lease and atomic run-state file by adapting the existing owner-safe scheduled-job/run-state primitives.
- [x] Expose `triggerPeriodDigestEffect`, `readPeriodDigestRunState`, and test-injectable sync/context/generation/publication boundaries.
- [x] Ensure the effect is server-owned and does not inherit the HTTP request abort signal.
- [x] Re-run focused tests and confirm GREEN.

### Task 3: Put Fixed Scheduled Runs Through the Orchestrator

**Files:**
- Modify: `src/lib/digest-archive-job.ts`
- Test: `src/lib/digest-archive-job.test.ts`
- Modify: `src/cli/register-jobs.ts`
- Test: `src/cli.test.ts`

- [x] Add failing tests that Today/24h scheduled commands invoke one orchestrator batch with `{ trigger: "scheduled", origin: "launchd" }` and do not write Markdown/JSON archives.
- [x] Add failing regression tests that Yesterday/Week still pre-sync, generate, archive, audit, and expose historical dates exactly as before.
- [x] Add CLI tests for explicit `--trigger`, `--origin`, `--requested-source`, and freshness attempt-token forwarding with strict enums.
- [x] Run the focused tests and confirm RED.
- [x] Split current-view periods from archived periods at the job/CLI boundary; do not delete legacy Today/24h files.
- [x] Rebuild the fixed Today/24h launchd plists to call the common orchestrator entry point; keep Yesterday/Week on the archive entry point.
- [x] Re-run focused tests and confirm GREEN.

### Task 4: Add Freshness Policy and Dynamic launchd Reconciliation

**Files:**
- Create: `src/lib/period-digest-freshness.ts`
- Create: `src/lib/period-digest-freshness.test.ts`
- Modify: `src/lib/launchd.ts`
- Test: `src/lib/launchd.test.ts`
- Modify: `src/lib/config.ts`
- Test: `src/lib/config.test.ts`

- [x] Write failing tests for a default of 12 hours and config validation from 1 through 24 hours.
- [x] Write failing due-time tests: `generatedAt + freshness`, recalculate after publication/config change, round up to the next launchd minute, and return no due time when it crosses the local calendar day.
- [x] Write failing token tests proving an obsolete or duplicate one-shot invocation becomes a no-op.
- [x] Write failing restart/reconcile tests for missing, stale, or inconsistent agents and surfaced install failures.
- [x] Run focused tests and confirm RED.
- [x] Implement one dynamic agent per current-view period with an opaque attempt token and serialized atomic plist update/install.
- [x] Reconcile on server startup, config save, successful publication, and metadata fallback; all valid wakeups enter the same orchestrator as `{ trigger: "freshness", origin: "launchd" }`.
- [x] Re-run focused tests and confirm GREEN.

### Task 5: Replace the Page APIs With Current-View Contracts

**Files:**
- Modify: `src/routes/api/period-digest.tsx`
- Test: `src/routes/api/period-digest.test.ts`
- Modify: `src/routes/api/period-digest-metadata.tsx`
- Test: `src/routes/api/period-digest-metadata.test.ts`
- Modify: `src/components/usePeriodDigestMetadata.ts`

- [x] Write failing metadata tests that stale/current content is always returned independently of `isGenerating`, including after failed generation.
- [x] Write failing trigger tests that manual refresh returns/join status immediately, records `origin: "page"` server-side, and cannot spoof launchd/CLI origin from query parameters.
- [x] Add tests for page fallback freshness detection joining the same token/orchestrator without creating a second run.
- [x] Run route tests and confirm RED.
- [x] Replace the in-memory parameter-rich registry contract with stable current content plus persisted period run state.
- [x] Preserve NDJSON response compatibility only where needed by existing clients; the browser must not own or cancel model generation.
- [x] Poll metadata while active and refetch after each source publication/run completion.
- [x] Re-run focused tests and confirm GREEN.

### Task 6: Update Config and Scheduler Visibility

**Files:**
- Modify: `src/routes/api/digest-schedule.tsx`
- Test: `src/routes/api/digest-schedule.test.ts`
- Modify: `src/routes/config.tsx`
- Test: `src/routes/config.test.tsx`

- [x] Write failing API tests for Today/24h freshness read/write, validation errors, install reconciliation, next due time, last trigger/run result, and visible installation failure.
- [x] Write failing UI tests for one shared numeric 1-24 hour control, the 12-hour default, estimated fixed/freshness model-call explanation, and scheduler health.
- [x] Run focused tests and confirm RED.
- [x] Implement the API and restrained Schedule-tab controls using the existing form patterns.
- [x] Recalculate/reinstall only affected dynamic agents after config changes while preserving fixed schedules and Yesterday/Week archive directory settings.
- [x] Re-run focused tests and confirm GREEN.

### Task 7: Make Today/24h Content Stable in the UI

**Files:**
- Modify: `src/routes/today.tsx`
- Test: `src/routes/today.test.tsx`
- Modify: `src/components/useReadOnlyDigest.ts`
- Modify: `src/lib/period-digest-url.ts`
- Test: related component/URL tests

- [x] Replace old tests with failing scenarios for all display rules 10a-i: old content remains before/during/after a trigger until a newer success atomically replaces it.
- [x] Add failing tests for visible generated timestamp, independent progress/error status, Refresh joining an active batch, and navigation not cancelling the batch.
- [x] Add failing tests proving Today/24h show neither Save nor DM controls and make no archive-read/save requests.
- [x] Keep regression tests for Yesterday/Week archive selection and historical display.
- [x] Run focused tests and confirm RED.
- [x] Separate displayed content state from generation state; never clear Markdown/context/result on start, stale detection, join, or failure.
- [x] Remove Save state/mutation and Today/24h `includeDms`; sanitize legacy URLs to the no-DM current-view identity.
- [x] Render the successful version's `generatedAt` on screen and keep Refresh available as a join operation.
- [x] Re-run focused tests and confirm GREEN.

### Task 8: Retire Today/24h Archive Endpoints Without Data Loss

**Files:**
- Modify: `src/routes/api/digest-archive-dates.tsx`
- Test: `src/routes/api/digest-archive-dates.test.ts`
- Modify: `src/routes/api/digest-archive-entry.tsx`
- Test: `src/routes/api/digest-archive-entry.test.ts`
- Delete: `src/routes/api/digest-archive-save.tsx`
- Delete: `src/routes/api/digest-archive-save.test.ts`
- Modify/regenerate: `src/routeTree.gen.ts`

- [x] Add failing tests that Today/24h archive reads return a clear 400 instead of silently becoming Yesterday and that Yesterday/Week remain readable.
- [x] Remove the obsolete Save route and generated route entries; do not delete any archive files on disk.
- [x] Regenerate the route tree using the repository's normal Vite/TanStack generation path.
- [x] Run all archive route and route-tree tests and confirm GREEN.

### Task 9: Integrate, Verify, and Update the PR

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-today-24h-digest-orchestration-design.md` only if implementation details differ materially.
- Modify: PR #51 description/comment after code is pushed.

- [x] Run the full suite: `pnpm test`.
- [x] Run static checks: `pnpm check`.
- [x] Run production build: `pnpm build`.
- [x] Start the local dev server on an available port and exercise Today, 24h, Yesterday, Week, and Config with Playwright at desktop and mobile viewports.
- [x] Verify screenshots have content during generation, visible timestamps, no Today/24h Save/DM controls, no overlap, and correct responsive layout.
- [x] Inspect the final diff for accidental archive deletion, generated metadata churn, secrets, or unrelated changes.
- [x] Commit coherent phases, push `codex/issue-50-digest-orchestration`, update PR #51 with implementation/test evidence, and request review.
