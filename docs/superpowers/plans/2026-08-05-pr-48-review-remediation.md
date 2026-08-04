# PR 48 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore scheduled digest compatibility, make digest locks renewable and bounded, fix managed credential precedence, and cache digest status audit reads.

**Architecture:** Keep legacy launch shell environment files separate from the strict managed Bird credential file. Extend scheduled locks with an owner-checked heartbeat and absolute lifetime, then connect the digest run-state heartbeat to it. Cache audit snapshots by file identity metadata without changing the status API contract.

**Tech Stack:** TypeScript, Effect, Commander, launchd plist generation, Vitest, TanStack Query.

---

### Task 1: Restore `--env-path` Compatibility

**Files:**

- Modify: `src/lib/digest-archive-job.test.ts`
- Modify: `src/routes/api/digest-schedule.test.ts`
- Modify: `src/cli.test.ts`
- Modify: `src/cli/register-jobs.ts`
- Modify: `src/lib/digest-archive-job.ts`
- Modify: `src/routes/api/digest-schedule.tsx`

- [ ] **Step 1: Write failing LaunchAgent and schedule tests**

Assert that `envFile` still creates the existing `/bin/bash -lc` launch wrapper,
that `birdCredentialsPath` adds `--bird-credentials-path` without a shell when
used alone, and that Config supplies `birdCredentialsPath` to all four periods.

- [ ] **Step 2: Run tests and verify the old implementation fails**

Run: `pnpm test -- src/lib/digest-archive-job.test.ts src/routes/api/digest-schedule.test.ts`

Expected: FAIL because `envFile` is currently passed to the strict digest parser
and `birdCredentialsPath` does not exist.

- [ ] **Step 3: Split the launch options**

Implement the equivalent of:

```ts
if (birdCredentialsPath) {
	args.push("--bird-credentials-path", resolveUserPath(birdCredentialsPath));
}
return buildLaunchProgramArguments({ program, args, envFile });
```

Add `--bird-credentials-path` to the run and install commands. Strictly parse only
that path. Keep install-time `--env-path` and `--env-file` mapped to `envFile`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm test -- src/lib/digest-archive-job.test.ts src/routes/api/digest-schedule.test.ts`

Expected: PASS.

### Task 2: Correct Credential Precedence

**Files:**

- Modify: `src/lib/bird-credentials.test.ts`
- Modify: `src/routes/api/bird-credentials-test.test.ts`
- Modify: `src/lib/bird-credentials.ts`

- [ ] **Step 1: Change expectations to the required precedence**

Assert that managed values override inherited `AUTH_TOKEN`/`CT0`, explicit values
override managed values, and unrelated inherited variables remain present. Set
conflicting inherited values in the Config test endpoint test.

- [ ] **Step 2: Run tests and verify they fail on inherited values**

Run: `pnpm test -- src/lib/bird-credentials.test.ts src/routes/api/bird-credentials-test.test.ts`

Expected: FAIL with the inherited credential pair winning.

- [ ] **Step 3: Reorder the merge**

Implement:

```ts
return {
	...process.env,
	...(credentials
		? { AUTH_TOKEN: credentials.authToken, CT0: credentials.ct0 }
		: {}),
	...explicit,
};
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm test -- src/lib/bird-credentials.test.ts src/routes/api/bird-credentials-test.test.ts`

Expected: PASS.

### Task 3: Convert Digest Locks to Renewable Leases

**Files:**

- Modify: `src/lib/scheduled-job.test.ts`
- Modify: `src/lib/digest-archive-run-state.test.ts`
- Modify: `src/lib/scheduled-job.ts`
- Modify: `src/lib/digest-archive-run-state.ts`
- Modify: `src/lib/digest-archive-job.ts`

- [ ] **Step 1: Write failing lock lease tests**

Replace the same-host live-PID permanence expectation with tests showing that an
expired heartbeat is stale, `release.heartbeat()` renews only its own lock, and a
lock older than six hours is stale even with a fresh mtime. Add a heartbeat-loop
test proving the optional lock callback runs.

- [ ] **Step 2: Run tests and verify the lease behavior is missing**

Run: `pnpm test -- src/lib/scheduled-job.test.ts src/lib/digest-archive-run-state.test.ts`

Expected: FAIL because releases have no heartbeat and PID reuse preserves stale
locks.

- [ ] **Step 3: Implement owner-checked renewal and bounded liveness**

Extend the callable release with:

```ts
heartbeat(): Promise<boolean>;
```

Refresh mtime through an opened file handle after verifying `ownerId`. Treat stale
mtime, dead same-host PID, or maximum age as inactive. Invoke the lock heartbeat
from `startDigestArchiveHeartbeat` and wire the acquired digest lock into it.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm test -- src/lib/scheduled-job.test.ts src/lib/digest-archive-run-state.test.ts src/lib/digest-archive-job.test.ts`

Expected: PASS.

### Task 4: Cache Digest Status Audit Reads

**Files:**

- Modify: `src/lib/digest-archive-job.test.ts`
- Modify: `src/lib/digest-archive-job.ts`

- [ ] **Step 1: Write a failing cache/invalidation test**

Spy on audit-log reads. Call status twice without changing the file and expect one
audit read, then append a record and expect a second read with the new snapshot.

- [ ] **Step 2: Run the test and verify repeated reads fail the expectation**

Run: `pnpm test -- src/lib/digest-archive-job.test.ts`

Expected: FAIL because every call reads and parses the complete audit log.

- [ ] **Step 3: Cache by path, size, and mtime and stop reverse scanning early**

Store the parsed result with `{ path, size, mtimeMs }`. Reuse only on an exact
metadata match, clear the cache on missing/read failure, and break after four
periods are found.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm test -- src/lib/digest-archive-job.test.ts`

Expected: PASS.

### Task 5: Update User Documentation and Verify

**Files:**

- Modify: `README.md`
- Modify: `docs/jobs.md`
- Modify: `docs/cli.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Document both credential paths and precedence**

Keep `--env-path` examples for general launch environments. Add the Config-managed
`~/.birdclaw/credentials/bird.env` path, strict file contract, shell-free
`--bird-credentials-path`, precedence, and migration guidance.

- [ ] **Step 2: Scan for contradictory option descriptions**

Run: `rg -n -- '--env-path|--bird-credentials-path|bird.env' README.md docs src/cli/register-jobs.ts`

Expected: every `--env-path` description retains general shell env semantics and
strict parsing is described only for `--bird-credentials-path`.

- [ ] **Step 3: Run formatting, lint, types, and the complete suite**

Run: `pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm test`

Expected: PASS with no failures.
