# Scheduled Digest Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scheduled digest runs perform one observable pre-sync, honor the configured AI language, expose partial failures as degraded runs, and keep Yesterday/Week views accurate while a three-source archive run is still in progress.

**Architecture:** Add a focused archive pre-sync module that owns transport selection and records one result per feed/mentions/thread operation. The archive job runs that module once under its existing lock, then generates `all`, `following`, and `for_you` sequentially from local data with `liveSync:false`. Archive JSON moves to schema v2 with language, batch status, and sync metadata while the reader remains compatible with v1. The read-only UI polls archive dates and the selected entry every two seconds while the status endpoint reports the period lock.

**Tech Stack:** TypeScript, Effect, React, TanStack Query, Vitest, Testing Library

---

## Task 1: Add a single archive pre-sync pipeline

**Files:**

- Create: `src/lib/digest-archive-sync.ts`
- Create: `src/lib/digest-archive-sync.test.ts`

- [x] Write failing tests for operation selection and order.

  Cover these cases:

  - `all`, `following`, and `for_you` together run `following`, `for_you`, `mentions`, then `mention_threads` exactly once each.
  - a `following`-only batch does not fetch For You or mentions.
  - a `for_you`-only batch forces Bird even when the configured mentions transport is xurl.
  - `liveSync:false` returns a skipped result without calling any transport.

- [x] Run `pnpm vitest run src/lib/digest-archive-sync.test.ts` and confirm the test fails because the module does not exist.

- [x] Implement `runDigestArchivePreSyncEffect` with these exported contracts:

  ```ts
  export type DigestArchiveSyncStatus = "fresh" | "degraded" | "skipped";
  export type DigestArchiveSyncOperation =
    | "following"
    | "for_you"
    | "mentions"
    | "mention_threads";

  export interface DigestArchiveSyncStep {
    operation: DigestArchiveSyncOperation;
    status: DigestArchiveSyncStatus;
    transport: "bird" | "xurl" | "auto" | "local";
    count?: number;
    error?: string;
  }

  export interface DigestArchiveSyncResult {
    status: DigestArchiveSyncStatus;
    steps: DigestArchiveSyncStep[];
  }
  ```

  Resolve the configured transport from `mentions.dataSource`: `bird`/`xurl`/`auto` use that live transport, while `birdclaw` records local/skipped steps. For You always calls `syncHomeTimelineEffect` with `mode:"bird"` and `following:false`. Following uses the configured live transport. Mentions use the configured transport; omit `startTime` for Bird because that transport does not support it. After the mention operation, collect local mention IDs for the requested period window and call `syncMentionThreadsEffect` with the same concrete transport (`auto` resolves to xurl for thread fetching). Catch each operation independently and record `degraded` plus the error instead of failing the whole effect. Treat partial thread results or per-thread failures as degraded.

- [x] Run `pnpm vitest run src/lib/digest-archive-sync.test.ts` and confirm all pre-sync tests pass.

## Task 2: Integrate pre-sync and language resolution into the archive job

**Files:**

- Modify: `src/lib/digest-archive-job.test.ts`
- Modify: `src/lib/digest-archive-job.ts`

- [x] Add failing tests proving:

  - pre-sync runs once before the first summary and receives the full requested source list;
  - every summary call receives `liveSync:false` after pre-sync;
  - language precedence is explicit option, `BIRDCLAW_DIGEST_LANGUAGE`, then `config.language.aiLanguage`;
  - a degraded pre-sync still generates every source, leaves legacy `ok:true` when generation succeeds, and sets `status:"degraded"`;
  - a generation failure sets `status:"failed"` while later sources still run.

- [x] Run `pnpm vitest run src/lib/digest-archive-job.test.ts` and confirm the new assertions fail against the current per-source live-sync behavior.

- [x] Add `language?: string` to `DigestArchiveJobOptions` and export `resolveDigestArchiveLanguage` with the required precedence. Include the resolved language in audit options and pass it to every `streamPeriodDigest` call.

- [x] Invoke `runDigestArchivePreSyncEffect` once after acquiring the lock. Pass period, account, requested sources, explicit window, and `liveSync: options.liveSync ?? true`. Always call `runOneContentSourceEffect` with `liveSync:false`.

- [x] Add `status:"ok" | "degraded" | "failed"` and `sync` to `DigestArchiveAuditEntry`. Keep `ok` for compatibility: it remains true after a degraded pre-sync when every AI archive and the final batch-metadata update succeed, and becomes false on either generation or persistence failure.

- [x] Run `pnpm vitest run src/lib/digest-archive-job.test.ts` and confirm the job tests pass.

## Task 3: Persist archive schema v2 without breaking v1 reads

**Files:**

- Modify: `src/lib/digest-archive-job.test.ts`
- Modify: `src/lib/digest-archive-job.ts`
- Verify: `src/routes/api/digest-archive-entry.tsx`

- [x] Add failing tests that inspect generated JSON and require `schemaVersion:2`, resolved language, final batch status, and full sync metadata. Add a fixture written as schema v1 and prove `readDigestArchiveEntry` still returns it.

- [x] Split the archive type into a shared base plus v1/v2 variants. V2 adds:

  ```ts
  schemaVersion: 2;
  language?: string;
  batchStatus: "ok" | "degraded" | "failed";
  sync: DigestArchiveSyncResult;
  ```

- [x] Write successful source files as v2. After all generation attempts finish, update each successful JSON file with the final batch status so earlier source files reflect a later source failure. Use a same-directory temporary file plus `rename` to prevent readers from observing partial JSON; this does not claim `fsync` durability across power loss.

- [x] Keep the existing reader tolerant: parse either v1 or v2 and return `null` only for missing or malformed JSON. Confirm the entry API continues mapping the shared digest fields without requiring a client contract change.

- [x] Run `pnpm vitest run src/lib/digest-archive-job.test.ts src/routes/api/digest-archive-entry.test.ts` (omit the second path if the repository has no dedicated test file) and confirm compatibility tests pass.

## Task 4: Poll and show honest progress for archived periods

**Files:**

- Modify: `src/components/useReadOnlyDigest.ts`
- Modify: `src/routes/today.test.tsx`
- Modify: `src/routes/today.tsx`

- [x] Add a failing route test that simulates this sequence for Yesterday:

  1. status endpoint reports `runningPeriods:["yesterday"]`;
  2. dates initially contain only `all` for the run date;
  3. the selected `for_you` entry initially returns `null`;
  4. a later poll adds `for_you` and returns the archived result.

  Assert the UI first shows `Generating scheduled digest 1/3` and `This source is still being generated.`, never shows `Ready` or the missing-archive message during the active run, then renders the result automatically.

- [x] Run `pnpm vitest run src/routes/today.test.tsx` and confirm the progress test fails.

- [x] Add a `running` parameter to `useReadOnlyDigest`. While true, set both dates and selected-entry queries to `refetchInterval: 2000`. Return `completedSources` for the effective date and `sourcePending` when the selected source is not yet present.

- [x] Move `useDigestArchiveRunningPeriods` before the read-only hook in `TodayRouteView`, derive `archiveRunning`, and pass it into the hook. During a run, show `Generating scheduled digest N/3`; if the current source has no result, show `This source is still being generated.` Keep source tabs enabled and let query polling replace the placeholder as soon as the JSON appears.

- [x] Preserve existing completed-run empty states: once the lock disappears, a missing source again shows the normal archived-source message and a period with no dates shows the not-yet-scheduled message.

- [x] Run `pnpm vitest run src/routes/today.test.tsx` and confirm all route tests pass.

## Task 5: Verify the complete change set

- [x] Run focused tests:

  ```sh
  pnpm vitest run src/lib/digest-archive-sync.test.ts src/lib/digest-archive-job.test.ts src/routes/today.test.tsx
  ```

- [x] Run repository checks:

  ```sh
  pnpm run check
  pnpm test
  pnpm run build
  ```

- [x] Review `git diff --check` and `git diff --stat`. Confirm no pre-existing prompt-template changes were reverted or accidentally staged. Do not create an implementation commit from overlapping dirty files unless the user explicitly requests it.
