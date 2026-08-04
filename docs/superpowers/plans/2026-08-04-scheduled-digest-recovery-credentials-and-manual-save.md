# Scheduled Digest Recovery, Credentials, and Manual Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Issue #47 by making scheduled digests sleep-safe and source-observable, adding visible generation timestamps and opt-in Today/24h archive replacement, and giving scheduled Bird sync a non-interactive Config-managed credential path.

**Architecture:** Keep the period lock as the mutual-exclusion primitive, add a digest-specific atomic run-state/heartbeat file for progress, and use the final JSONL audit for post-run failures. Extend the archive API and Today route to consume that state, add a server-cache-backed single-source replacement endpoint, and store X credentials in a permission-restricted file that BirdClaw parses itself rather than shell-sourcing.

**Tech Stack:** TypeScript, Effect, TanStack Router/Query, React, Zod, Vitest/Testing Library, Node filesystem/process APIs, launchd.

---

## File Map

**New focused modules and routes**

- `src/lib/digest-archive-run-state.ts`: versioned active-run state, atomic writes, heartbeat, owner-safe cleanup, and status projection.
- `src/lib/digest-archive-run-state.test.ts`: run-state and heartbeat tests with temporary roots and fake clocks.
- `src/lib/sensitive-values.ts`: shared URL/header/token redaction for persisted and API-visible failures.
- `src/lib/sensitive-values.test.ts`: redaction coverage for AUTH_TOKEN, CT0, bearer values, and sensitive URL parameters.
- `src/lib/bird-credentials.ts`: strict two-key credential parser/store, permissions, status, and child environment composition.
- `src/lib/bird-credentials.test.ts`: parser, permissions, replacement, clearing, and secret-safety tests.
- `src/routes/api/bird-credentials.tsx`: status/save/replace/clear API without secret readback.
- `src/routes/api/bird-credentials.test.ts`: route contract and redaction tests.
- `src/routes/api/bird-credentials-test.tsx`: authenticated non-interactive `bird whoami` probe.
- `src/routes/api/bird-credentials-test.test.ts`: success/failure route tests.
- `src/routes/api/digest-archive-save.tsx`: Today/24h single-source optimistic replacement endpoint.
- `src/routes/api/digest-archive-save.test.ts`: cache identity, conflict, and one-file replacement tests.

**Existing files with scoped changes**

- `src/lib/scheduled-job.ts` and `.test.ts`: PID-aware stale detection and owner-token release.
- `src/lib/digest-archive-job.ts` and `.test.ts`: run-state transitions, heartbeat, attempt timeout, archive v3, manual replacement helper, and final-audit lookup.
- `src/lib/digest-archive-sync.ts` and `.test.ts`: non-interactive Bird credential gate using shared sensitive-error redaction.
- `src/lib/period-digest.ts` and `.test.ts`: read the exact latest server-cached digest for a requested option set.
- `src/routes/api/digest-archive-status.tsx` and `.test.ts`: rich active runs and latest final source states.
- `src/components/useDigestArchiveStatus.ts`: validate/project rich status and poll every two seconds.
- `src/components/useReadOnlyDigest.ts`: Today/24h active-run archive reads and stable final refetch.
- `src/routes/today.tsx` and `.test.tsx`: partial scheduled view, visible generated timestamp, manual-refresh eligibility, Save mutation, and conflict UX.
- `src/lib/bird-command.ts` and `.test.ts`: merge stored credentials into Bird's child environment without logging them.
- `src/cli/register-jobs.ts` and `src/cli.test.ts`: preserve `envFile` for `--period all` and pass it to the run command for strict parsing.
- `src/lib/digest-archive-job.ts` launchd builder tests: pass the credential path as a BirdClaw argument, not through `/bin/bash -lc`.
- `src/routes/api/digest-schedule.tsx` and `.test.ts`: retain the managed credential path on reinstall.
- `src/routes/config.tsx` and `.test.tsx`: X Credentials Config tab and no-readback flows.
- `src/routeTree.gen.ts`: generated TanStack route registrations for the new API routes.

### Task 1: Make Scheduled Lock Ownership PID-Aware

**Files:**
- Modify: `src/lib/scheduled-job.ts`
- Test: `src/lib/scheduled-job.test.ts`

- [ ] **Step 1: Add failing tests for sleep-safe stale detection and owner-safe release**

Add cases that write an old lock for the current live PID and an old lock for a non-existent PID:

```ts
it("keeps an old same-host lock while its pid is alive", async () => {
	const lockPath = path.join(makeTempDir(), "locks", "job.lock");
	writeFileSync(
		lockPath,
		JSON.stringify({
			ownerId: "live-owner",
			startedAt: new Date(Date.now() - 3_600_000).toISOString(),
			host: os.hostname(),
			pid: process.pid,
		}),
		"utf8",
	);
	const old = new Date(Date.now() - 3_600_000);
	utimesSync(lockPath, old, old);

	await expect(peekScheduledJobLockMetadata(lockPath, 60_000)).resolves.toMatchObject({
		ownerId: "live-owner",
		pid: process.pid,
	});
	await expect(acquireScheduledJobLock(lockPath, 60_000)).resolves.toBeUndefined();
});

it("reclaims a dead old owner and does not let an old release delete its successor", async () => {
	const lockPath = path.join(makeTempDir(), "locks", "job.lock");
	writeFileSync(lockPath, JSON.stringify({
		ownerId: "dead-owner",
		startedAt: new Date(0).toISOString(),
		host: os.hostname(),
		pid: 2_147_483_647,
	}), "utf8");
	const old = new Date(Date.now() - 61_000);
	utimesSync(lockPath, old, old);

	const release = await acquireScheduledJobLock(lockPath, 60_000);
	expect(JSON.parse(readFileSync(lockPath, "utf8")).ownerId).not.toBe("dead-owner");
	await release?.();
	expect(existsSync(lockPath)).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm test -- src/lib/scheduled-job.test.ts`

Expected: FAIL because old live-PID locks are currently hidden/replaced and `ownerId` is absent.

- [ ] **Step 3: Add an owner token and centralize liveness-aware lock inspection**

Extend `ScheduledJobLockMetadata` with `ownerId`, generate it with `randomUUID()`, and use this helper from acquire and peek:

```ts
function processIsAlive(pid: number) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return Boolean(
			error && typeof error === "object" && "code" in error && error.code === "EPERM",
		);
	}
}

function lockIsActive(metadata: ScheduledJobLockMetadata, ageMs: number, staleMs: number) {
	if (metadata.host === os.hostname() && processIsAlive(metadata.pid)) return true;
	return ageMs <= staleMs;
}
```

The release closure must re-read the file and remove it only when its `ownerId` still matches the acquired owner.

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `pnpm test -- src/lib/scheduled-job.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the lock change**

```bash
git add src/lib/scheduled-job.ts src/lib/scheduled-job.test.ts
git commit -m "fix: keep live scheduled job locks across sleep"
```

### Task 2: Add Persistent Digest Run State and Integrate It Into the Job

**Files:**
- Create: `src/lib/digest-archive-run-state.ts`
- Create: `src/lib/digest-archive-run-state.test.ts`
- Create: `src/lib/sensitive-values.ts`
- Create: `src/lib/sensitive-values.test.ts`
- Modify: `src/lib/digest-archive-job.ts`
- Test: `src/lib/digest-archive-job.test.ts`

- [ ] **Step 1: Write failing run-state tests**

Cover atomic state creation, source transitions, a heartbeat update, and owner-safe removal:

```ts
const initial = createDigestArchiveRunState({
	period: "today",
	runDate: "2026-08-04",
	ownerId: "owner-1",
	contentSources: ["all", "following", "for_you"],
	now: new Date("2026-08-04T00:00:00.000Z"),
});
await writeDigestArchiveRunState(statePath, initial);
await updateDigestArchiveRunState(statePath, "owner-1", (state) => ({
	...state,
	phase: "generating",
	currentSource: "all",
	sources: { ...state.sources, all: { state: "running", attempts: 1 } },
}));
expect(await readDigestArchiveRunState(statePath)).toMatchObject({
	ownerId: "owner-1",
	phase: "generating",
	currentSource: "all",
	sources: { all: { state: "running", attempts: 1 } },
});
await removeDigestArchiveRunState(statePath, "other-owner");
expect(existsSync(statePath)).toBe(true);
await removeDigestArchiveRunState(statePath, "owner-1");
expect(existsSync(statePath)).toBe(false);
```

- [ ] **Step 2: Run the new test and confirm RED**

Run: `pnpm test -- src/lib/digest-archive-run-state.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Extract shared sensitive-value redaction**

Move the existing URL, bearer, and token-parameter redaction from `digest-archive-sync.ts` into `redactSensitiveText(value: string)` and `sensitiveErrorMessage(error: unknown)` in `sensitive-values.ts`. Add `AUTH_TOKEN` and `CT0` to the recognized key pattern and prove exact token values never survive the helper.

- [ ] **Step 4: Implement the versioned state module**

Define the approved contract and focused APIs:

```ts
export type DigestRunPhase = "pre-sync" | "generating" | "finalizing";
export type DigestSourceState = "pending" | "running" | "completed" | "failed";

export interface DigestArchiveRunStateV1 {
	schemaVersion: 1;
	ownerId: string;
	period: PeriodDigestPreset;
	pid: number;
	host: string;
	runDate: string;
	startedAt: string;
	lastHeartbeatAt: string;
	phase: DigestRunPhase;
	currentSource?: PeriodDigestContentSource;
	totalSources: number;
	sources: Partial<Record<PeriodDigestContentSource, {
		state: DigestSourceState;
		attempts: number;
		generatedAt?: string;
		error?: string;
	}>>;
}
```

Export `digestArchiveRunStatePath`, `createDigestArchiveRunState`, `readDigestArchiveRunState`, `writeDigestArchiveRunState`, `updateDigestArchiveRunState`, `startDigestArchiveHeartbeat`, and `removeDigestArchiveRunState`. Use same-directory temp files plus rename; heartbeat every 15 seconds and a supplied clock/timer boundary in tests.

- [ ] **Step 5: Run state and redaction tests and confirm GREEN**

Run: `pnpm test -- src/lib/digest-archive-run-state.test.ts src/lib/sensitive-values.test.ts`

Expected: PASS.

- [ ] **Step 6: Add failing job tests for phase/source transitions and 10-minute attempt timeout**

Mock the state writer and `streamPeriodDigest` so the first attempt rejects with an abort after the injected `modelTimeoutMs`, then succeeds. Assert transitions `pre-sync -> generating/all running -> all completed -> finalizing` and state cleanup in both success and failure paths.

- [ ] **Step 7: Run job tests and confirm RED**

Run: `pnpm test -- src/lib/digest-archive-job.test.ts`

Expected: FAIL because the job does not write state or pass an attempt signal.

- [ ] **Step 8: Integrate state and timeout into `runDigestArchiveJobEffect`**

Add `modelTimeoutMs?: number` to options with a 600,000 ms default. After lock acquisition, generate an independent state owner ID, create state, start heartbeat, update before/after pre-sync and each source, pass a new `AbortSignal.timeout(modelTimeoutMs)` to every retry attempt, mark failures with redacted messages, then final-audit and owner-safe state cleanup plus lease-safe lock release in `ensuring`.

- [ ] **Step 9: Run focused tests and commit**

Run: `pnpm test -- src/lib/digest-archive-run-state.test.ts src/lib/sensitive-values.test.ts src/lib/digest-archive-job.test.ts`

Expected: PASS.

```bash
git add src/lib/digest-archive-run-state.ts src/lib/digest-archive-run-state.test.ts src/lib/sensitive-values.ts src/lib/sensitive-values.test.ts src/lib/digest-archive-job.ts src/lib/digest-archive-job.test.ts
git commit -m "feat: persist scheduled digest progress"
```

### Task 3: Expose Rich Active and Final Source Status

**Files:**
- Modify: `src/lib/digest-archive-job.ts`
- Modify: `src/routes/api/digest-archive-status.tsx`
- Test: `src/routes/api/digest-archive-status.test.ts`
- Modify: `src/components/useDigestArchiveStatus.ts`

- [ ] **Step 1: Write failing status-route tests**

Use an active run with a completed All source and running For You, plus a final failed source summary:

```ts
peekDigestArchiveStatusEffectMock.mockResolvedValue({
	activeRuns: [{
		period: "today",
		runDate: "2026-08-04",
		phase: "generating",
		currentSource: "for_you",
		startedAt: "2026-08-04T00:00:00.000Z",
		lastHeartbeatAt: "2026-08-04T00:01:00.000Z",
		totalSources: 3,
		sources: {
			all: { state: "completed", attempts: 1, generatedAt: "2026-08-04T00:00:40.000Z" },
			for_you: { state: "running", attempts: 1 },
			following: { state: "pending", attempts: 0 },
		},
	}],
	lastRuns: [],
});
```

Assert the response preserves the source map and derives `runningPeriods`.

- [ ] **Step 2: Run status tests and confirm RED**

Run: `pnpm test -- src/routes/api/digest-archive-status.test.ts`

Expected: FAIL because the route returns only run date and count.

- [ ] **Step 3: Project state and latest audit through one status function**

Replace `peekDigestArchiveRunningRunsEffect` usage with `getDigestArchiveStatusEffect`, which reads each period's run state (falling back conservatively to lock metadata) and reads the latest valid audit entry per period. Return only sanitized fields needed by the UI.

- [ ] **Step 4: Extend the client schema and reduce polling to two seconds**

Validate `phase`, `currentSource`, timestamps, and the source map with Zod. Return `activeRuns`, `lastRuns`, and `runningPeriods` maps/sets from `useDigestArchiveStatus`.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test -- src/routes/api/digest-archive-status.test.ts`

Expected: PASS.

```bash
git add src/lib/digest-archive-job.ts src/routes/api/digest-archive-status.tsx src/routes/api/digest-archive-status.test.ts src/components/useDigestArchiveStatus.ts
git commit -m "feat: expose scheduled digest source progress"
```

### Task 4: Render Partial Scheduled Results and Generation Timestamps

**Files:**
- Modify: `src/components/useReadOnlyDigest.ts`
- Modify: `src/routes/today.tsx`
- Test: `src/routes/today.test.tsx`

- [ ] **Step 1: Add failing UI tests**

Add cases for:

1. Today/All renders its archived Markdown while Today/For You remains running.
2. Yesterday/For You shows progress, not `No archived`, when the live PID run exceeds 45 minutes.
3. A completed run performs a final refetch without blanking already rendered Markdown.
4. Today, 24h, Yesterday, and Week render `Generated Aug 4, 2026, 8:38 AM` from the selected result.
5. A source missing after a failed final step shows the sanitized failure instead of a generic missing archive.

Use the existing request router in `today.test.tsx`; return rich status payloads and assert the selected archive entry URL.

- [ ] **Step 2: Run the UI tests and confirm RED**

Run: `pnpm test -- src/routes/today.test.tsx`

Expected: FAIL because Today/24h never enable the archive reader and the screen status omits the timestamp.

- [ ] **Step 3: Generalize `useReadOnlyDigest` for active Today/24h runs**

Remove its Yesterday/Week-only assumption. Keep its last active run date through the final refetch, poll the selected entry only while that exact date/source is active, and expose the source state/error supplied by the status hook.

- [ ] **Step 4: Select archive mode per active run, not only per period kind**

In `TodayRouteView`, compute:

```ts
const activeArchiveRun = archiveStatus.activeRuns.get(period);
const scheduledView = Boolean(activeArchiveRun);
const readFromArchive = isArchivedPeriod || scheduledView || archived.finalizing;
```

Use the archived result while `readFromArchive` is true, render a completed source immediately, show `Generating scheduled digest N/total - Current Source` for pending sources, and retain Markdown during finalization.

- [ ] **Step 5: Add a visible generated timestamp**

Render the existing formatted `result.updatedAt` in the screen-visible status row, not only the print-only metadata:

```tsx
{result ? (
	<span data-testid="digest-generated-at">
		Generated {new Date(result.updatedAt).toLocaleString(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		})}
	</span>
) : null}
```

- [ ] **Step 6: Run tests and commit**

Run: `pnpm test -- src/routes/today.test.tsx`

Expected: PASS.

```bash
git add src/components/useReadOnlyDigest.ts src/routes/today.tsx src/routes/today.test.tsx
git commit -m "feat: show partial scheduled digests and timestamps"
```

### Task 5: Add Exact Single-Source Manual Archive Replacement

**Files:**
- Modify: `src/lib/period-digest.ts`
- Test: `src/lib/period-digest.test.ts`
- Modify: `src/lib/digest-archive-job.ts`
- Test: `src/lib/digest-archive-job.test.ts`
- Create: `src/routes/api/digest-archive-save.tsx`
- Create: `src/routes/api/digest-archive-save.test.ts`

- [ ] **Step 1: Add failing cache-reader tests**

Test an exported `readLatestPeriodDigestEffect(options)` that resolves the current prompt hash and latest cache key, requires cached context, and returns the exact result with its stored `updatedAt`.

- [ ] **Step 2: Run cache tests and confirm RED**

Run: `pnpm test -- src/lib/period-digest.test.ts`

Expected: FAIL because no public latest-result reader exists.

- [ ] **Step 3: Implement the server-side latest-result reader**

Reuse `latestDigestCacheKey`, `resolveEffectivePrompt`, `readSyncCache`, and `cachedDigestResult`; do not regenerate or accept client digest content.

- [ ] **Step 4: Add archive v3 and replacement tests**

Assert that `replaceDigestArchiveEntryEffect` updates only one selected JSON/Markdown pair, writes JSON last, records `archiveOrigin: "manual"`, preserves `generatedAt` from the result, records `savedAt`, and leaves two sibling sources byte-for-byte unchanged. Keep v1/v2 reader tests.

- [ ] **Step 5: Implement archive v3 and the replacement helper**

Add this variant without changing v1/v2 readers:

```ts
export interface PeriodDigestArchiveFileV3 extends PeriodDigestArchiveFileBase {
	schemaVersion: 3;
	archiveOrigin: "scheduled" | "manual";
	savedAt: string;
	language?: string;
	batchStatus?: DigestArchiveBatchStatus;
	sync?: DigestArchiveSyncResult;
}
```

Scheduled writes use `archiveOrigin: "scheduled"`; manual writes omit scheduled batch claims. Stage both files, rename Markdown first, and rename JSON last as the publication marker.

- [ ] **Step 6: Add failing route tests for validation and conflicts**

POST body:

```ts
{
	period: "today",
	contentSource: "following",
	includeDms: false,
	expectedUpdatedAt: "2026-08-04T01:23:45.000Z"
}
```

Cover rejection of Yesterday/Week, missing cache, timestamp mismatch, an active same-period scheduled run, and a successful one-source save.

- [ ] **Step 7: Implement `/api/digest-archive-save`**

Validate with Zod, enforce sensitive-request protection, check active ownership server-side, read the exact server cache, compare `updatedAt`, call the replacement helper, append a sanitized manual-save audit, and return `{ ok, period, contentSource, generatedAt, savedAt }` without digest content.

- [ ] **Step 8: Run focused tests and commit**

Run: `pnpm test -- src/lib/period-digest.test.ts src/lib/digest-archive-job.test.ts src/routes/api/digest-archive-save.test.ts`

Expected: PASS.

```bash
git add src/lib/period-digest.ts src/lib/period-digest.test.ts src/lib/digest-archive-job.ts src/lib/digest-archive-job.test.ts src/routes/api/digest-archive-save.tsx src/routes/api/digest-archive-save.test.ts
git commit -m "feat: replace one manually refreshed digest archive"
```

### Task 6: Add the Six Independent Save Opportunities to Today/24h

**Files:**
- Modify: `src/routes/today.tsx`
- Test: `src/routes/today.test.tsx`

- [ ] **Step 1: Write failing Save state-machine tests**

Cover every invariant with at least one table-driven case over Today/24h and All/For You/Following:

- initial cached/scheduled result: Save disabled;
- manual Refresh in the selected combination: disabled while streaming, enabled on `done`;
- Save request contains only selected period/source/options/timestamp;
- success changes label to Saved and disables;
- another manual Refresh re-enables for the new timestamp;
- switching combinations never transfers eligibility;
- page remount clears eligibility;
- conflict keeps the result visible and Save retryable.

- [ ] **Step 2: Run the Today tests and confirm RED**

Run: `pnpm test -- src/routes/today.test.tsx`

Expected: FAIL because no Save button or manual-generation identity exists.

- [ ] **Step 3: Track manual completion by exact view and timestamp**

Wrap `useNdjsonRun.run` so `run(true)` records a pending manual request and the next `done` event calls `onManualResult(result.updatedAt)`. Store eligibility in `TodayRouteView` as a map keyed by `${period}:${contentSource}:${includeDms}`. Clear that key at Refresh start and after Save success.

- [ ] **Step 4: Add the Save mutation and control**

Render a Lucide `Save` button beside Refresh for Today/24h. Disable unless the displayed result timestamp equals the eligible timestamp, no stream is active, and no same-period scheduled run exists. POST to `/api/digest-archive-save`; on success show `Saved`, invalidate matching archive queries, and on failure show the existing retryable error treatment without clearing Markdown.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test -- src/routes/today.test.tsx src/routes/api/digest-archive-save.test.ts`

Expected: PASS.

```bash
git add src/routes/today.tsx src/routes/today.test.tsx
git commit -m "feat: save manually refreshed Today and 24h digests"
```

### Task 7: Build the Permission-Restricted Credential Store and API

**Files:**
- Create: `src/lib/bird-credentials.ts`
- Create: `src/lib/bird-credentials.test.ts`
- Create: `src/routes/api/bird-credentials.tsx`
- Create: `src/routes/api/bird-credentials.test.ts`
- Create: `src/routes/api/bird-credentials-test.tsx`
- Create: `src/routes/api/bird-credentials-test.test.ts`

- [ ] **Step 1: Write failing credential-store tests**

Test both values required, CR/LF rejection, strict parsing of only `AUTH_TOKEN` and `CT0`, directory `0700`, file `0600`, atomic replacement, status with mtime but no values, clear, and environment composition where an explicit call option overrides managed values.

- [ ] **Step 2: Run store tests and confirm RED**

Run: `pnpm test -- src/lib/bird-credentials.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the strict store**

Export this public surface:

```ts
export interface BirdCredentials { authToken: string; ct0: string }
export interface BirdCredentialStatus { configured: boolean; complete: boolean; updatedAt?: string }

export function getBirdCredentialsPath(): string;
export function readBirdCredentials(): BirdCredentials | null;
export function writeBirdCredentials(credentials: BirdCredentials): BirdCredentialStatus;
export function clearBirdCredentials(): void;
export function getBirdCredentialStatus(): BirdCredentialStatus;
export function mergeBirdCredentialEnvironment(explicit?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
```

Serialize exactly two quoted-free, newline-free assignments. Parse line-by-line; never evaluate or source the file.

- [ ] **Step 4: Add failing API tests**

Assert GET returns only status, POST requires both values and never echoes them, DELETE clears, and the test route calls a dependency-injected `bird whoami` with an environment containing both managed values. Verify token-shaped failures are redacted.

- [ ] **Step 5: Implement status/save/clear and test routes**

Use `requestJsonEffect`, Zod, `sensitiveRequestErrorResponse`, and sanitized JSON errors. The probe route must return only `{ ok: true }` or `{ ok: false, error: sanitized }`.

- [ ] **Step 6: Run focused tests and commit**

Run: `pnpm test -- src/lib/bird-credentials.test.ts src/routes/api/bird-credentials.test.ts src/routes/api/bird-credentials-test.test.ts`

Expected: PASS.

```bash
git add src/lib/bird-credentials.ts src/lib/bird-credentials.test.ts src/routes/api/bird-credentials.tsx src/routes/api/bird-credentials.test.ts src/routes/api/bird-credentials-test.tsx src/routes/api/bird-credentials-test.test.ts
git commit -m "feat: manage X credentials without secret readback"
```

### Task 8: Add X Credentials to Config

**Files:**
- Modify: `src/routes/config.tsx`
- Test: `src/routes/config.test.tsx`

- [ ] **Step 1: Write failing Config UI tests**

Mock status as unconfigured and configured. Assert password inputs start empty, Save requires both, success clears inputs and shows Configured, a reload never receives token fields, Replace accepts a new pair, Test reports sanitized success/failure, and Clear returns to Not configured.

- [ ] **Step 2: Run Config tests and confirm RED**

Run: `pnpm test -- src/routes/config.test.tsx`

Expected: FAIL because the X Credentials tab does not exist.

- [ ] **Step 3: Implement the credentials tab**

Add `credentials` to `activeTab`, use password inputs with labels `AUTH_TOKEN` and `CT0`, and provide Save/Replace, Test, and Clear controls using Lucide `Save`, `ShieldCheck`, and `Trash2`. Keep values blank after every successful mutation and display only Configured/Not configured plus the local formatted update time.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test -- src/routes/config.test.tsx`

Expected: PASS.

```bash
git add src/routes/config.tsx src/routes/config.test.tsx
git commit -m "feat: configure X credentials in the UI"
```

### Task 9: Use Managed Credentials Non-Interactively and Preserve Their Path

**Files:**
- Modify: `src/lib/bird-command.ts`
- Test: `src/lib/bird-command.test.ts`
- Modify: `src/lib/digest-archive-sync.ts`
- Test: `src/lib/digest-archive-sync.test.ts`
- Modify: `src/lib/digest-archive-job.ts`
- Test: `src/lib/digest-archive-job.test.ts`
- Modify: `src/cli/register-jobs.ts`
- Test: `src/cli.test.ts`
- Modify: `src/routes/api/digest-schedule.tsx`
- Test: `src/routes/api/digest-schedule.test.ts`

- [ ] **Step 1: Add failing Bird environment and no-fallback tests**

Assert `runBirdCommandEffect` passes `process.env + managed credentials + explicit env` to the subprocess without placing token values in arguments or errors. In scheduled pre-sync, assert missing credentials creates degraded Bird steps and the Bird/timeline functions are never invoked.

- [ ] **Step 2: Run Bird/sync tests and confirm RED**

Run: `pnpm test -- src/lib/bird-command.test.ts src/lib/digest-archive-sync.test.ts`

Expected: FAIL because managed credentials are not loaded and scheduled sync still invokes Bird fallback.

- [ ] **Step 3: Merge managed credentials in `bird-command` and gate scheduled Bird work**

Call `mergeBirdCredentialEnvironment(options?.env)` before `runSubprocessEffect`. Extend `DigestArchivePreSyncOptions` with `nonInteractiveBird?: boolean`; when true, require a complete managed pair before Following-in-Bird, For You, Bird mentions, or Bird thread calls. Record a redacted degraded step instead of invoking those effects.

- [ ] **Step 4: Add failing LaunchAgent/CLI/schedule tests**

Assert:

- `install-digest-archive-launchd --period all --env-path /tmp/bird.env` passes that path to all four overrides;
- digest LaunchAgent arguments include `--env-path /tmp/bird.env` on the BirdClaw job command and do not contain `/bin/bash -lc` or token values;
- the run command strictly parses that file before invoking the job;
- Config schedule POST supplies `getBirdCredentialsPath()` for all four reinstall calls.

- [ ] **Step 5: Preserve the path and parse it inside BirdClaw**

Add `envFile` to `perPeriodOverrides`. For digest LaunchAgents, append `--env-path <resolved path>` to `run-digest-archive` arguments instead of passing it to `buildLaunchProgramArguments` for shell sourcing. Add the same option to the run command and load only the two allowed keys with `bird-credentials.ts`. Make schedule POST use the fixed managed path.

- [ ] **Step 6: Run focused tests and commit**

Run: `pnpm test -- src/lib/bird-command.test.ts src/lib/digest-archive-sync.test.ts src/lib/digest-archive-job.test.ts src/cli.test.ts src/routes/api/digest-schedule.test.ts`

Expected: PASS.

```bash
git add src/lib/bird-command.ts src/lib/bird-command.test.ts src/lib/digest-archive-sync.ts src/lib/digest-archive-sync.test.ts src/lib/digest-archive-job.ts src/lib/digest-archive-job.test.ts src/cli/register-jobs.ts src/cli.test.ts src/routes/api/digest-schedule.tsx src/routes/api/digest-schedule.test.ts
git commit -m "fix: keep scheduled Bird authentication non-interactive"
```

### Task 10: Full Verification, Review, and PR

**Files:**
- Modify: `src/routeTree.gen.ts` through the repository's TanStack route generator
- Review: all files changed since `origin/main`

- [ ] **Step 1: Run all focused Issue #47 tests together**

Run:

```bash
pnpm test -- \
  src/lib/scheduled-job.test.ts \
  src/lib/digest-archive-run-state.test.ts \
  src/lib/digest-archive-job.test.ts \
  src/routes/api/digest-archive-status.test.ts \
  src/routes/today.test.tsx \
  src/lib/period-digest.test.ts \
  src/routes/api/digest-archive-save.test.ts \
  src/lib/bird-credentials.test.ts \
  src/routes/api/bird-credentials.test.ts \
  src/routes/api/bird-credentials-test.test.ts \
  src/routes/config.test.tsx \
  src/lib/bird-command.test.ts \
  src/lib/digest-archive-sync.test.ts \
  src/cli.test.ts \
  src/routes/api/digest-schedule.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository gates**

Run:

```bash
pnpm run check
pnpm test
pnpm run build
git diff --check origin/main...HEAD
```

Expected: all commands exit 0.

- [ ] **Step 3: Perform a security-focused diff review**

Search the diff for `AUTH_TOKEN`, `CT0`, credential values in JSON/logging, shell sourcing, command-line token arguments, unsafe permission defaults, and race-prone archive writes. Confirm API responses and UI schemas contain status only.

- [ ] **Step 4: Run local browser verification**

Start the dev server, verify Config credentials states and Today/24h Save states at desktop and mobile widths, and confirm buttons/text do not overlap. Use mocked/test credentials; do not enter or capture live tokens in screenshots.

- [ ] **Step 5: Commit the generated route tree**

```bash
git add src/routeTree.gen.ts
git commit -m "chore: register digest recovery API routes"
```

Expected: the generated tree registers `bird-credentials`, `bird-credentials-test`, and `digest-archive-save`. If it was already committed by an earlier route-generation command and `git status --short src/routeTree.gen.ts` is empty, skip this commit.

- [ ] **Step 6: Push and create the PR**

Push `codex/issue-47-digest-recovery` and open a PR against `main` with `Closes #47`, a change summary, security notes, and exact verification commands/results. Confirm the PR diff contains the Issue #47 design/plan and implementation only, not the two unrelated local Issue #44 documentation commits.
