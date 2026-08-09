# Issue #58 Freshness Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Today/24h freshness attempts recover from same-day all-source failures with three bounded background retries and one final page-visible recovery attempt.

**Architecture:** `period-digest-freshness.ts` owns a persistent attempt state machine and an idempotent completion transition. The page trigger and launchd CLI both feed the shared digest run's completion back into that state machine; the React hook only changes its request identity when a terminal run changes, while server-side locks and tokens remain the correctness boundary.

**Tech Stack:** TypeScript, Node.js filesystem APIs, launchd agent helpers, React Query, Vitest, Testing Library

---

## File Map

- Modify `src/lib/period-digest-freshness.ts`: add lifecycle fields, origin-aware atomic consumption, bounded retry scheduling, and idempotent completion.
- Modify `src/lib/period-digest-freshness.test.ts`: cover state transitions, retry delays, retry cap, page recovery, cross-day behavior, concurrency, and completion observation.
- Modify `src/cli/register-jobs.ts`: pass launchd origin into consume and write the completed batch outcome back to freshness state.
- Modify `src/cli.test.ts`: verify launchd failure completion is persisted and obsolete tokens remain skipped.
- Modify `src/components/usePeriodDigestMetadata.ts`: include the last terminal run identity in the client-side freshness request key.
- Modify `src/routes/today.test.tsx`: verify one POST per terminal failed run while preserving stale content.
- Modify `src/routes/config.tsx`: render truthful running, retryable, and exhausted freshness status.
- Modify `src/routes/config.test.tsx`: cover the new retry status text.
- Verify `src/routes/api/period-digest-freshness.tsx` and its test without changing the API contract.

### Task 1: Persistent Freshness Attempt State Machine

**Files:**
- Modify: `src/lib/period-digest-freshness.ts`
- Test: `src/lib/period-digest-freshness.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add imports for `completePeriodDigestFreshnessAttempt` and
`PeriodDigestFreshnessStateV1`, then append tests that prove the state is `running`
after consume, failures schedule the three configured delays, and the fourth failure
becomes terminal:

```ts
it("moves a failed running attempt through bounded retry backoff", async () => {
	const install = vi.fn(async () => ({ ok: true }) as LaunchAgentInstallResult);
	const dueAt = new Date(2026, 7, 6, 10, 30, 0);
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "today",
		attemptToken: "retry-token",
		dueAt: dueAt.toISOString(),
		fireAt: dueAt.toISOString(),
		status: "scheduled",
		updatedAt: dueAt.toISOString(),
	});

	const failureTimes = [
		new Date(2026, 7, 6, 10, 31, 0),
		new Date(2026, 7, 6, 10, 47, 0),
		new Date(2026, 7, 6, 11, 48, 0),
		new Date(2026, 7, 6, 15, 49, 0),
	];
	const expectedRetryAt = [
		new Date(2026, 7, 6, 10, 46, 0),
		new Date(2026, 7, 6, 11, 47, 0),
		new Date(2026, 7, 6, 15, 48, 0),
	];

	for (const [index, now] of failureTimes.entries()) {
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "retry-token",
				origin: "launchd",
				now,
			}),
		).resolves.toEqual({ valid: true });
		expect((await readPeriodDigestFreshnessState("today"))?.status).toBe(
			"running",
		);

		const completed = await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "retry-token",
			outcome: "failed",
			now,
			install,
		});
		if (index < expectedRetryAt.length) {
			expect(completed.state).toMatchObject({
				status: "retryable",
				retryCount: index + 1,
				retryAt: expectedRetryAt[index]?.toISOString(),
			});
		} else {
			expect(completed.state).toMatchObject({
				status: "failed",
				retryCount: 3,
			});
		}
	}
	expect(install).toHaveBeenCalledTimes(3);
});
```

Update the existing one-shot consume test to pass `origin: "launchd"`, expect the persisted status to be `running`, and expect a second consume to return `already-running`.

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run:

```bash
pnpm test src/lib/period-digest-freshness.test.ts
```

Expected: FAIL because `completePeriodDigestFreshnessAttempt` does not exist, `origin` is not accepted, and consume still persists `consumed`.

- [ ] **Step 3: Add lifecycle types and origin-aware consume**

Extend the state interface and add constants:

```ts
export type PeriodDigestFreshnessOrigin = "launchd" | "page" | "cli";

export interface PeriodDigestFreshnessStateV1 {
	schemaVersion: 1;
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	dueAt: string;
	fireAt: string;
	status:
		| "scheduled"
		| "running"
		| "retryable"
		| "failed"
		| "consumed"
		| "disabled"
		| "error";
	updatedAt: string;
	consumedAt?: string;
	completedAt?: string;
	installError?: string;
	freshnessSeconds?: number;
	sourceIdentities?: Partial<Record<PeriodDigestContentSource, string>>;
	suppressedSourceIdentities?: Partial<
		Record<PeriodDigestContentSource, string>
	>;
	startedAt?: string;
	retryCount?: number;
	retryAt?: string;
	pageRecoveryUsedAt?: string;
	failedAt?: string;
}

const FRESHNESS_RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
```

Change consume to accept `origin` and select the eligibility deadline from `retryAt` for retryable states and `dueAt` otherwise. Handle states in this order:

```ts
if (state.status === "disabled") {
	return { valid: false, reason: "disabled" } as const;
}
if (state.status === "running") {
	return { valid: false, reason: "already-running" } as const;
}
const pageRecovery =
	origin === "page" &&
	["failed", "consumed", "error"].includes(state.status) &&
	(state.status !== "consumed" || !state.completedAt) &&
	!state.pageRecoveryUsedAt;
if (
	["failed", "consumed", "error"].includes(state.status) &&
	!pageRecovery
) {
	return { valid: false, reason: "already-consumed" } as const;
}
const eligibleAt = new Date(
	state.status === "retryable" ? (state.retryAt ?? "") : state.dueAt,
);
if (!sameLocalDay(new Date(state.dueAt), now)) {
	return { valid: false, reason: "cross-day" } as const;
}
if (!pageRecovery && now.getTime() < eligibleAt.getTime()) {
	return { valid: false, reason: "not-due" } as const;
}
await writeStateFile(statePath, {
	...state,
	status: "running",
	startedAt: now.toISOString(),
	updatedAt: now.toISOString(),
	...(pageRecovery ? { pageRecoveryUsedAt: now.toISOString() } : {}),
});
return { valid: true } as const;
```

Add `disabled` and `already-running` to the invalid reason union. Preserve the token, retryCount, and pageRecoveryUsedAt on every transition.

When reconciliation calculates the same token, preserve lifecycle states that must not be
reset or reinstalled:

```ts
if (
	previous?.attemptToken === attemptToken &&
	["running", "retryable", "failed", "consumed"].includes(previous.status)
) {
	return { state: previous, installResult: null };
}
```

Keep `error` outside this guard so an explicit reconciliation can retry a failed agent
installation. If the error belongs to the same token, copy its `retryCount`, `retryAt`, and
`pageRecoveryUsedAt` into the replacement scheduled state instead of resetting the budget.

```ts
const sameAttemptMetadata =
	previous?.attemptToken === attemptToken
		? {
				...(previous.retryCount !== undefined
					? { retryCount: previous.retryCount }
					: {}),
				...(previous.retryAt ? { retryAt: previous.retryAt } : {}),
				...(previous.pageRecoveryUsedAt
					? { pageRecoveryUsedAt: previous.pageRecoveryUsedAt }
					: {}),
			}
		: {};

const state: PeriodDigestFreshnessStateV1 = {
	schemaVersion: 1,
	period,
	attemptToken,
	dueAt: dueAt.toISOString(),
	fireAt: fireAt.toISOString(),
	status: "scheduled",
	updatedAt: now.toISOString(),
	freshnessSeconds,
	sourceIdentities,
	suppressedSourceIdentities,
	...sameAttemptMetadata,
};
```

- [ ] **Step 4: Implement idempotent completion and retry installation**

Add the exported operation below. Keep the read/write/install work inside the existing scheduler lease and state queue. Build the retry agent with the same attempt token and resolved program/env settings:

```ts
export async function completePeriodDigestFreshnessAttempt({
	period,
	attemptToken,
	outcome,
	now = new Date(),
	install = installLaunchAgent,
	installOptions,
	program,
	envFile,
}: {
	period: CurrentPeriodDigestPeriod;
	attemptToken: string;
	outcome: "published" | "failed";
	now?: Date;
	install?: (
		agent: LaunchAgent,
		options?: LaunchAgentInstallOptions,
	) => Promise<LaunchAgentInstallResult>;
	installOptions?: LaunchAgentInstallOptions;
	program?: string;
	envFile?: string;
}) {
	const statePath = periodDigestFreshnessStatePath(period);
	return withFreshnessSchedulerLease(period, () =>
		serializeState(statePath, async () => {
			const state = await readPeriodDigestFreshnessState(period);
			if (!state || state.attemptToken !== attemptToken || state.status !== "running") {
				return { state, installResult: null, updated: false as const };
			}
			if (outcome === "published") {
				const consumed = {
					...state,
					status: "consumed" as const,
					consumedAt: now.toISOString(),
					completedAt: now.toISOString(),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, consumed);
				return { state: consumed, installResult: null, updated: true as const };
			}
			if (state.pageRecoveryUsedAt) {
				const failed = {
					...state,
					status: "failed" as const,
					failedAt: now.toISOString(),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, failed);
				return { state: failed, installResult: null, updated: true as const };
			}
			const retryCount = state.retryCount ?? 0;
			const delay = FRESHNESS_RETRY_DELAYS_MS[retryCount];
			if (delay === undefined) {
				const failed = {
					...state,
					status: "failed" as const,
					failedAt: now.toISOString(),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, failed);
				return { state: failed, installResult: null, updated: true as const };
			}
			const retryAt = roundUpToMinute(new Date(now.getTime() + delay));
			if (!sameLocalDay(retryAt, now)) {
				const disabled = {
					...state,
					status: "disabled" as const,
					retryCount: retryCount + 1,
					retryAt: retryAt.toISOString(),
					fireAt: "",
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, disabled);
				return { state: disabled, installResult: null, updated: true as const };
			}
			const retryable = {
				...state,
				status: "retryable" as const,
				retryCount: retryCount + 1,
				retryAt: retryAt.toISOString(),
				fireAt: retryAt.toISOString(),
				updatedAt: now.toISOString(),
			};
			await writeStateFile(statePath, retryable);
			const agent = buildPeriodDigestFreshnessLaunchAgent({
				period,
				fireAt: retryAt,
				attemptToken,
				program: program ?? resolveDigestLaunchdExecution().program,
				envFile: envFile ?? resolveDigestLaunchdExecution().envFile,
			});
			try {
				const installResult = await install(agent, installOptions);
				return { state: retryable, installResult, updated: true as const };
			} catch (error) {
				const failedInstall = {
					...retryable,
					status: "error" as const,
					installError: error instanceof Error ? error.message : String(error),
					updatedAt: now.toISOString(),
				};
				await writeStateFile(statePath, failedInstall);
				return { state: failedInstall, installResult: null, updated: true as const };
			}
		}),
	);
}
```

- [ ] **Step 5: Add complete edge-case tests**

Add the following focused tests:

```ts
it("allows one same-day page recovery after automatic retries are exhausted", async () => {
	const dueAt = new Date(2026, 7, 6, 10, 30, 0);
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "today",
		attemptToken: "page-recovery",
		dueAt: dueAt.toISOString(),
		fireAt: dueAt.toISOString(),
		status: "failed",
		retryCount: 3,
		updatedAt: new Date(2026, 7, 6, 15, 0, 0).toISOString(),
	});
	const now = new Date(2026, 7, 6, 16, 0, 0);

	await expect(
		consumePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "page-recovery",
			origin: "page",
			now,
		}),
	).resolves.toEqual({ valid: true });
	expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
		status: "running",
		pageRecoveryUsedAt: now.toISOString(),
	});

	const install = vi.fn();
	await completePeriodDigestFreshnessAttempt({
		period: "today",
		attemptToken: "page-recovery",
		outcome: "failed",
		now: new Date(2026, 7, 6, 16, 1, 0),
		install,
	});
	expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
		status: "failed",
		retryCount: 3,
	});
	expect(install).not.toHaveBeenCalled();
	await expect(
		consumePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "page-recovery",
			origin: "page",
			now: new Date(2026, 7, 6, 16, 2, 0),
		}),
	).resolves.toEqual({ valid: false, reason: "already-consumed" });
});

it.each(["consumed", "error"] as const)(
	"recovers one legacy %s state from the page",
	async (status) => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: `legacy-${status}`,
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status,
			updatedAt: dueAt.toISOString(),
		});

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "24h",
				attemptToken: `legacy-${status}`,
				origin: "page",
				now: new Date(2026, 7, 6, 12, 0, 0),
			}),
		).resolves.toEqual({ valid: true });
		expect(await readPeriodDigestFreshnessState("24h")).toMatchObject({
			status: "running",
			pageRecoveryUsedAt: new Date(2026, 7, 6, 12, 0, 0).toISOString(),
		});
	},
);

it("disables a retry whose retryAt crosses the local day", async () => {
	const dueAt = new Date(2026, 7, 6, 23, 0, 0);
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "today",
		attemptToken: "late-token",
		dueAt: dueAt.toISOString(),
		fireAt: dueAt.toISOString(),
		status: "running",
		updatedAt: dueAt.toISOString(),
	});
	const install = vi.fn();

	const result = await completePeriodDigestFreshnessAttempt({
		period: "today",
		attemptToken: "late-token",
		outcome: "failed",
		now: new Date(2026, 7, 6, 23, 55, 0),
		install,
	});

	expect(result.state).toMatchObject({
		status: "disabled",
		retryCount: 1,
		retryAt: new Date(2026, 7, 7, 0, 10, 0).toISOString(),
	});
	expect(install).not.toHaveBeenCalled();
});

it("ignores duplicate completion and completion for a replaced token", async () => {
	const dueAt = new Date(2026, 7, 6, 10, 30, 0);
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "today",
		attemptToken: "completed-token",
		dueAt: dueAt.toISOString(),
		fireAt: dueAt.toISOString(),
		status: "running",
		updatedAt: dueAt.toISOString(),
	});
	const first = await completePeriodDigestFreshnessAttempt({
		period: "today",
		attemptToken: "completed-token",
		outcome: "published",
		now: new Date(2026, 7, 6, 11, 0, 0),
	});
	const duplicate = await completePeriodDigestFreshnessAttempt({
		period: "today",
		attemptToken: "completed-token",
		outcome: "published",
		now: new Date(2026, 7, 6, 11, 1, 0),
	});
	await writePeriodDigestFreshnessState({
		...(first.state as PeriodDigestFreshnessStateV1),
		attemptToken: "replacement-token",
		status: "scheduled",
	});
	const replaced = await completePeriodDigestFreshnessAttempt({
		period: "today",
		attemptToken: "completed-token",
		outcome: "failed",
		now: new Date(2026, 7, 6, 11, 2, 0),
	});

	expect(first.updated).toBe(true);
	expect(duplicate.updated).toBe(false);
	expect(replaced.updated).toBe(false);
});

it("lets only one concurrent caller move a token to running", async () => {
	const dueAt = new Date(2026, 7, 6, 10, 30, 0);
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "24h",
		attemptToken: "concurrent-token",
		dueAt: dueAt.toISOString(),
		fireAt: dueAt.toISOString(),
		status: "scheduled",
		updatedAt: dueAt.toISOString(),
	});
	const input = {
		period: "24h" as const,
		attemptToken: "concurrent-token",
		origin: "launchd" as const,
		now: new Date(2026, 7, 6, 10, 31, 0),
	};

	const results = await Promise.all([
		consumePeriodDigestFreshnessAttempt(input),
		consumePeriodDigestFreshnessAttempt(input),
	]);
	expect(results).toEqual(
		expect.arrayContaining([
			{ valid: true },
			{ valid: false, reason: "already-running" },
		]),
	);
});
```

- [ ] **Step 6: Run the core tests and verify GREEN**

Run:

```bash
pnpm test src/lib/period-digest-freshness.test.ts
```

Expected: PASS with all prior scheduling, lease, corruption, and installation tests still green.

- [ ] **Step 7: Commit the state machine**

```bash
git add src/lib/period-digest-freshness.ts src/lib/period-digest-freshness.test.ts
git commit -m "fix: make freshness attempts retryable"
```

### Task 2: Feed Page-Triggered Run Completion Back Into Freshness

**Files:**
- Modify: `src/lib/period-digest-freshness.ts`
- Test: `src/lib/period-digest-freshness.test.ts`
- Verify: `src/routes/api/period-digest-freshness.test.ts`

- [ ] **Step 1: Write a failing page completion test**

Add a failed completion and an injected completion writer to the existing page fallback test:

```ts
it("marks a page-triggered all-source failure retryable", async () => {
	const dueAt = new Date(2026, 7, 6, 10, 30, 0);
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "today",
		attemptToken: "page-token",
		dueAt: dueAt.toISOString(),
		fireAt: dueAt.toISOString(),
		status: "scheduled",
		updatedAt: dueAt.toISOString(),
	});
	const requestRun = vi.fn(async () => ({
		runId: "failed-run",
		joined: false,
		completion: Promise.resolve({ phase: "failed" as const }),
	}));
	const completeAttempt = vi.fn(async () => undefined);

	await triggerDuePeriodDigestFreshness({
		period: "today",
		origin: "page",
		now: new Date(2026, 7, 6, 10, 31, 0),
		requestRun,
		completeAttempt,
	});
	await vi.waitFor(() => {
		expect(completeAttempt).toHaveBeenCalledWith({
			period: "today",
			attemptToken: "page-token",
			outcome: "failed",
		});
	});
});
```

- [ ] **Step 2: Run the page completion test and verify RED**

Run:

```bash
pnpm test src/lib/period-digest-freshness.test.ts -t "page-triggered all-source failure"
```

Expected: FAIL because the trigger does not observe `run.completion` and the state remains `running`.

- [ ] **Step 3: Observe completion without delaying the API response**

Extend the injected run type and trigger options:

```ts
type FreshnessRunCompletion = Promise<{ phase: "completed" | "degraded" | "failed" }>;

requestRun?: (request: {
	period: CurrentPeriodDigestPeriod;
	trigger: "freshness";
	origin: "page" | "cli";
}) => Promise<{
	runId: string;
	joined: boolean;
	completion: FreshnessRunCompletion;
}>;
completeAttempt?: typeof completePeriodDigestFreshnessAttempt;
```

Pass `origin` to consume. After `requestRun` resolves, attach but do not await:

```ts
const finishAttempt = completeAttempt ?? completePeriodDigestFreshnessAttempt;
void run.completion
	.then((finalState) =>
		finishAttempt({
			period,
			attemptToken: state.attemptToken,
			outcome: finalState.phase === "failed" ? "failed" : "published",
		}),
	)
	.catch(() => undefined);
```

Return the existing `{ triggered, runId, joined }` object unchanged so the route remains immediate and backward compatible.

- [ ] **Step 4: Add the same-day failure-to-recovery regression**

Add one composed test that uses the real consume and completion state machine:

```ts
it("recovers a failed launchd attempt from the page on the same day", async () => {
	const dueAt = new Date(2026, 7, 6, 10, 30, 0);
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "today",
		attemptToken: "dark-wake-token",
		dueAt: dueAt.toISOString(),
		fireAt: dueAt.toISOString(),
		status: "scheduled",
		updatedAt: dueAt.toISOString(),
	});
	await consumePeriodDigestFreshnessAttempt({
		period: "today",
		attemptToken: "dark-wake-token",
		origin: "launchd",
		now: new Date(2026, 7, 6, 10, 31, 0),
	});
	const install = vi.fn(
		async () => ({ ok: true }) as LaunchAgentInstallResult,
	);
	await completePeriodDigestFreshnessAttempt({
		period: "today",
		attemptToken: "dark-wake-token",
		outcome: "failed",
		now: new Date(2026, 7, 6, 10, 31, 0),
		install,
	});
	const successAt = new Date(2026, 7, 6, 10, 46, 0);
	const requestRun = vi.fn(async () => ({
		runId: "recovery-run",
		joined: false,
		completion: Promise.resolve({ phase: "completed" as const }),
	}));

	await triggerDuePeriodDigestFreshness({
		period: "today",
		origin: "page",
		now: successAt,
		requestRun,
		completeAttempt: (input) =>
			completePeriodDigestFreshnessAttempt({
				...input,
				now: successAt,
				install,
			}),
	});
	await vi.waitFor(async () => {
		expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
			status: "consumed",
			retryCount: 1,
		});
	});
	expect(requestRun).toHaveBeenCalledOnce();
	expect(install).toHaveBeenCalledOnce();
});
```

The existing successful orchestrator/reconciliation tests continue to prove that a real
published source changes the version identity and creates the next scheduled token before
this completion observer runs.

- [ ] **Step 5: Run freshness and route tests**

Run:

```bash
pnpm test src/lib/period-digest-freshness.test.ts src/routes/api/period-digest-freshness.test.ts
```

Expected: PASS; route response remains unchanged and page completion transitions asynchronously.

- [ ] **Step 6: Commit page completion wiring**

```bash
git add src/lib/period-digest-freshness.ts src/lib/period-digest-freshness.test.ts
git commit -m "fix: observe page freshness completion"
```

### Task 3: Feed Launchd CLI Completion Back Into Freshness

**Files:**
- Modify: `src/cli/register-jobs.ts`
- Modify: `src/cli.test.ts`

- [ ] **Step 1: Write failing CLI expectations**

Add a hoisted mock and export it from the freshness module mock:

```ts
const completePeriodDigestFreshnessAttemptMock = vi.hoisted(() => vi.fn());

vi.mock("#/lib/period-digest-freshness", () => ({
	consumePeriodDigestFreshnessAttempt: (...args: unknown[]) =>
		consumePeriodDigestFreshnessAttemptMock(...args),
	completePeriodDigestFreshnessAttempt: (...args: unknown[]) =>
		completePeriodDigestFreshnessAttemptMock(...args),
	reconcileAllPeriodDigestFreshness: (...args: unknown[]) =>
		reconcileAllPeriodDigestFreshnessMock(...args),
}));
```

In the existing failed freshness wakeup test, assert:

```ts
expect(consumePeriodDigestFreshnessAttemptMock).toHaveBeenCalledWith({
	period: "today",
	attemptToken: "valid-token",
	origin: "launchd",
});
expect(completePeriodDigestFreshnessAttemptMock).toHaveBeenCalledWith({
	period: "today",
	attemptToken: "valid-token",
	outcome: "failed",
});
```

Also assert the obsolete-token test passes `origin: "launchd"` and never calls completion.

- [ ] **Step 2: Run the CLI test and verify RED**

Run:

```bash
pnpm test src/cli.test.ts -t "freshness"
```

Expected: FAIL because origin and completion are not wired.

- [ ] **Step 3: Complete the attempt after the run finishes**

Import `completePeriodDigestFreshnessAttempt`. Track the validated token locally:

```ts
let freshnessAttemptToken: string | undefined;
if (trigger === "freshness" && origin === "launchd") {
	if (!options.attemptToken) {
		throw new Error("--attempt-token is required for freshness launchd wakeups");
	}
	const attempt = await consumePeriodDigestFreshnessAttempt({
		period,
		attemptToken: options.attemptToken,
		origin: "launchd",
	});
	if (!attempt.valid) {
		print({ ok: true, skipped: attempt.reason, period }, true);
		return;
	}
	freshnessAttemptToken = options.attemptToken;
}
```

Immediately after awaiting `run.completion`, write the outcome before printing or setting exitCode:

```ts
if (freshnessAttemptToken) {
	await completePeriodDigestFreshnessAttempt({
		period,
		attemptToken: freshnessAttemptToken,
		outcome: state.phase === "failed" ? "failed" : "published",
	});
}
```

- [ ] **Step 4: Run CLI and core freshness tests**

Run:

```bash
pnpm test src/cli.test.ts src/lib/period-digest-freshness.test.ts
```

Expected: PASS, including token rejection, failed batch exit code, and retry scheduling.

- [ ] **Step 5: Commit CLI completion wiring**

```bash
git add src/cli/register-jobs.ts src/cli.test.ts
git commit -m "fix: persist launchd freshness outcomes"
```

### Task 4: Let the Page Re-evaluate After Each Failed Run

**Files:**
- Modify: `src/components/usePeriodDigestMetadata.ts`
- Modify: `src/routes/today.test.tsx`

- [ ] **Step 1: Write a failing failed-run identity test**

Add a Today route test whose metadata mock returns one failed run, then a different failed run after focus/refetch. Keep the digest `updatedAt` unchanged and assert two total freshness POSTs, one for each run:

```ts
it("retries freshness once for each newly failed run", async () => {
	let freshnessRequests = 0;
	let runVersion = 1;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname === "/api/data-sources") {
				return jsonResponse(dataSourcesResponse());
			}
			if (url.pathname === "/api/digest-archive-status") {
				return jsonResponse({ ok: true, runningPeriods: [] });
			}
			if (url.pathname === "/api/period-digest-metadata") {
				return jsonResponse(
					metadataResponse({
						isStale: true,
						runState: {
							runId: `failed-${String(runVersion)}`,
							phase: "failed",
							finishedAt: runVersion === 2
								? "2026-08-06T12:00:00.000Z"
								: "2026-08-06T11:00:00.000Z",
						},
					}),
				);
			}
			if (url.pathname === "/api/period-digest-freshness") {
				freshnessRequests += 1;
				return jsonResponse({ ok: true, triggered: false, reason: "not-due" });
			}
			throw new Error(`Unexpected fetch ${url.pathname}`);
		}),
	);

	render(<TodayRoute searchState={currentSearch()} />);
	await waitFor(() => expect(freshnessRequests).toBe(1));
	focusManager.setFocused(false);
	runVersion = 2;
	focusManager.setFocused(true);
	await waitFor(() => expect(freshnessRequests).toBe(2));
	expect(screen.getByRole("heading", { name: "Stable Today", level: 1 })).toBeVisible();
});
```

Keep the existing test asserting only one POST for repeated renders of the same run identity.

- [ ] **Step 2: Run the Today test and verify RED**

Run:

```bash
pnpm test src/routes/today.test.tsx -t "freshness"
```

Expected: FAIL because the current key only contains the unchanged digest `updatedAt`.

- [ ] **Step 3: Add terminal run identity to the freshness key**

Derive a defensive identity from the loose runState payload:

```ts
function terminalRunIdentity(runState: unknown) {
	if (!runState || typeof runState !== "object") return "no-run";
	const value = runState as Record<string, unknown>;
	if (
		typeof value.runId !== "string" ||
		typeof value.finishedAt !== "string" ||
		(value.phase !== "completed" &&
			value.phase !== "degraded" &&
			value.phase !== "failed")
	) {
		return "active-run";
	}
	return `${value.runId}:${value.finishedAt}:${String(value.phase)}`;
}
```

Build the key with this value:

```ts
const freshnessKey = [
	period,
	contentSource,
	query.data?.result?.updatedAt ?? "empty",
	terminalRunIdentity(query.data?.runState),
].join(":");
```

- [ ] **Step 4: Run Today and API tests**

Run:

```bash
pnpm test src/routes/today.test.tsx src/routes/api/period-digest-freshness.test.ts
```

Expected: PASS; stale content remains visible and the route contract is unchanged.

- [ ] **Step 5: Commit page retry identity**

```bash
git add src/components/usePeriodDigestMetadata.ts src/routes/today.test.tsx
git commit -m "fix: retry stale digest after failed runs"
```

### Task 5: Show Retry State in Config

**Files:**
- Modify: `src/routes/config.tsx`
- Modify: `src/routes/config.test.tsx`

- [ ] **Step 1: Write a failing Config status test**

Extend the schedule response test fixture so Today is retryable and 24h has exhausted both
automatic and page recovery:

```ts
freshness: {
	today: {
		status: "retryable",
		dueAt: "2026-08-06T10:00:00.000Z",
		fireAt: "2026-08-06T11:15:00.000Z",
		retryAt: "2026-08-06T11:15:00.000Z",
		retryCount: 1,
	},
	"24h": {
		status: "failed",
		dueAt: "2026-08-06T10:00:00.000Z",
		fireAt: "2026-08-06T15:00:00.000Z",
		retryCount: 3,
		pageRecoveryUsedAt: "2026-08-06T16:00:00.000Z",
	},
},
```

Assert the rendered text:

```ts
expect(await screen.findByText(/Today.*重试于/u)).toBeVisible();
expect(screen.getByText(/24h.*今日刷新已结束/u)).toBeVisible();
```

- [ ] **Step 2: Run the Config test and verify RED**

```bash
pnpm test src/routes/config.test.tsx -t "schedule"
```

Expected: FAIL because every non-scheduled, non-error state currently renders as
`今日不再触发超时更新` and the response schema drops retry metadata.

- [ ] **Step 3: Parse and render the new states**

Add the optional fields to both Today and 24h objects in `digestScheduleResponseSchema`:

```ts
retryAt: z.string().optional(),
retryCount: z.number().int().nonnegative().optional(),
pageRecoveryUsedAt: z.string().optional(),
```

Replace the nested status ternary with a focused formatter:

```ts
function digestFreshnessStatusText(freshness: {
	status: string;
	dueAt: string;
	retryAt?: string;
	pageRecoveryUsedAt?: string;
	installError?: string;
}) {
	if (freshness.status === "scheduled") {
		return `下次超时 ${new Date(freshness.dueAt).toLocaleString()}`;
	}
	if (freshness.status === "running") return "正在刷新";
	if (freshness.status === "retryable" && freshness.retryAt) {
		return `重试于 ${new Date(freshness.retryAt).toLocaleString()}`;
	}
	if (freshness.status === "failed") {
		return freshness.pageRecoveryUsedAt
			? "今日刷新已结束"
			: "自动重试已结束，等待页面恢复";
	}
	if (freshness.status === "error") {
		return `调度安装失败：${freshness.installError ?? "未知错误"}`;
	}
	return "今日不再触发超时更新";
}
```

Call this formatter from the existing Today/24h status rows.

- [ ] **Step 4: Run Config tests and verify GREEN**

```bash
pnpm test src/routes/config.test.tsx src/routes/api/digest-schedule.test.ts
```

Expected: PASS with scheduled, retryable, failed, and inactive schedule displays intact.

- [ ] **Step 5: Commit Config status support**

```bash
git add src/routes/config.tsx src/routes/config.test.tsx
git commit -m "fix: display freshness retry status"
```

### Task 6: Regression and Repository Verification

**Files:**
- Verify all files changed in Tasks 1-4

- [ ] **Step 1: Run the focused regression suite**

```bash
pnpm test \
	src/lib/period-digest-freshness.test.ts \
	src/lib/period-digest-orchestrator.test.ts \
	src/routes/api/period-digest-freshness.test.ts \
	src/routes/today.test.tsx \
	src/routes/config.test.tsx \
	src/routes/api/digest-schedule.test.ts \
	src/cli.test.ts
```

Expected: all selected test files pass. The existing orchestrator assertion that an all-source failure does not perform normal publication reconciliation remains valid because attempt completion is handled by the freshness callers.

- [ ] **Step 2: Run static checks**

```bash
pnpm run check
```

Expected: formatting, lint, and TypeScript checks pass without warnings.

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: all test files pass; baseline before implementation was 181 files and 1759 tests.

- [ ] **Step 4: Inspect the final diff**

```bash
git status --short
git diff --check main...HEAD
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected: only the design/plan and the eight implementation/test files listed above are changed; no whitespace errors or unrelated edits are present.

- [ ] **Step 5: Commit verification-only adjustments if needed**

If formatting changes tracked implementation files, stage only those files and commit:

```bash
git add src/lib/period-digest-freshness.ts src/lib/period-digest-freshness.test.ts src/cli/register-jobs.ts src/cli.test.ts src/components/usePeriodDigestMetadata.ts src/routes/today.test.tsx src/routes/config.tsx src/routes/config.test.tsx
git commit -m "chore: finalize freshness recovery"
```

Skip this commit when verification does not modify files.

## Post-Review Hardening

Independent review identified three retry edges that the original task sequence did not cover:

- [x] Preserve `retryable` and its original `retryAt` when reconciling a same-token retry installation error.
- [x] Return `eligibleAt` for `not-due` page requests and re-evaluate the same stale version when that time arrives.
- [x] Avoid unloading a running launchd job from itself. Install a separate, short-lived reloader that waits for the parent CLI to exit, validates the token again, activates the target agent, persists activation errors, and removes itself.
- [x] Use that deferred reloader for successful and degraded launchd freshness reconciliation too; the activator accepts only the matching `scheduled` or `retryable` token.

The final verification commands above must be rerun after these hardening commits.
