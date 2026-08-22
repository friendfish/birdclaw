# Issue #62 Cross-Midnight Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent previous-day Today/24h freshness work from firing before the new day's fixed digest while preserving same-day recovery after missed or failed fixed runs.

**Architecture:** Clamp every source base to the current local day's fixed schedule, include that schedule instant in the daily attempt identity, and scope inherited suppressions to the same state cycle day. Rebuild stale-day state at the page/CLI trigger boundary and let scheduled all-source failures establish the fallback baseline through the existing reconciliation and lock machinery.

**Tech Stack:** TypeScript, Node.js 26.5, Vitest, launchd scheduling helpers, JSON freshness state, SQLite current digest store

---

## File Map

- Modify `src/lib/period-digest-freshness.ts`: deadline floor, cycle-date helpers, daily token, suppression lifecycle, and stale trigger reconciliation.
- Modify `src/lib/period-digest-freshness.test.ts`: calculator, daily identity, suppression, cross-day trigger, overdue recovery, and running-state regressions.
- Modify `src/lib/period-digest-orchestrator.ts`: reconcile scheduled all-source failures without suppressing the unchanged sources.
- Modify `src/lib/period-digest-orchestrator.test.ts`: scheduled/freshness/manual all-failure contracts.
- Keep `docs/superpowers/specs/2026-08-22-issue-62-cross-midnight-freshness-design.md` as the approved behavior contract.

Use the repository runtime for every command:

```bash
export PATH=/Users/friendfish/.nvm/versions/node/v26.5.0/bin:$PATH
```

### Task 1: Clamp Pre-Schedule Source Generations

**Files:**
- Modify: `src/lib/period-digest-freshness.test.ts:26`
- Modify: `src/lib/period-digest-freshness.ts:178`

- [x] **Step 1: Write the issue reproduction test**

Add this test after the first calculator test:

```ts
it("clamps cross-midnight source generations to the fixed daily schedule", () => {
	const due = calculatePeriodDigestFreshnessDeadline({
		now: new Date(2026, 7, 21, 4, 2, 0),
		freshnessSeconds: 4 * 60 * 60,
		schedule: { hour: 7, minute: 30 },
		generatedAt: {
			following: new Date(2026, 7, 21, 0, 1, 0).toISOString(),
			for_you: new Date(2026, 7, 21, 0, 7, 0).toISOString(),
		},
		suppressedSources: ["all"],
	});

	expect(due).toEqual(new Date(2026, 7, 21, 11, 30, 0));
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-freshness.test.ts -t "clamps cross-midnight source generations"
```

Expected: FAIL because the current result is `2026-08-21 04:01` local time instead of 11:30.

- [x] **Step 3: Apply the minimum deadline floor**

Replace the source base selection with:

```ts
const generatedIsEligible =
	Number.isFinite(generated.getTime()) &&
	sameLocalDay(generated, now) &&
	generated.getTime() >= scheduledBase.getTime();
const base = generatedIsEligible ? generated : scheduledBase;
```

- [x] **Step 4: Verify GREEN and existing calculator behavior**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-freshness.test.ts -t "generation time|fixed schedule|cross-midnight|never schedules across a day"
```

Expected: all selected calculator tests PASS, including the existing cross-midnight-disable case.

- [x] **Step 5: Commit the isolated calculator fix**

```bash
git add src/lib/period-digest-freshness.ts src/lib/period-digest-freshness.test.ts
git commit -m "fix: clamp freshness to daily schedule"
```

### Task 2: Establish a Daily Attempt Cycle and Reset Old Suppressions

**Files:**
- Modify: `src/lib/period-digest-freshness.test.ts:5-24`
- Modify: `src/lib/period-digest-freshness.test.ts:860-1280`
- Modify: `src/lib/period-digest-freshness.ts:99-105`
- Modify: `src/lib/period-digest-freshness.ts:970-1030`

- [x] **Step 1: Add current-digest test fixtures**

Add these imports:

```ts
import type {
	PeriodDigestContentSource,
	PeriodDigestContext,
	PeriodDigestRunResult,
} from "./period-digest";
import { publishCurrentPeriodDigest } from "./period-digest-current-store";
```

Add this fixture after `testHome`:

```ts
function publishCurrentSources(
	period: "today" | "24h",
	generatedAt: string,
) {
	const { db } = testHome();
	for (const contentSource of [
		"all",
		"following",
		"for_you",
	] as const satisfies readonly PeriodDigestContentSource[]) {
		const context: PeriodDigestContext = {
			window: {
				label: period === "today" ? "Today" : "Last 24 hours",
				since: "2026-08-20T00:00:00.000Z",
				until: "2026-08-21T08:00:00.000Z",
			},
			includeDms: false,
			contentSource,
			counts: {
				home: 0,
				mentions: 0,
				authored: 0,
				likes: 0,
				bookmarks: 0,
				dms: 0,
				links: 0,
			},
			tweets: [],
			dms: [],
			links: [],
			hash: `${period}:${contentSource}`,
		};
		const result: PeriodDigestRunResult = {
			context,
			digest: {
				title: `${period} ${contentSource}`,
				summary: "A complete digest",
				keyTopics: [],
				notableLinks: [],
				people: [],
				actionItems: [],
				sourceTweetIds: [],
			},
			markdown: `# ${period} ${contentSource}`,
			model: "gpt-5.5",
			reasoningEffort: "medium",
			serviceTier: "priority",
			parseStatus: "structured",
			cached: false,
			updatedAt: generatedAt,
		};
		publishCurrentPeriodDigest(
			{
				period,
				contentSource,
				runId: "stable-run",
				versionId: `stable-${contentSource}`,
				generatedAt,
				result,
				promptHash: "prompt",
				maxTweets: 5_000,
				maxLinks: 20,
				sync: { status: "fresh", steps: [] },
			},
			db,
		);
	}
}
```

- [x] **Step 2: Write failing daily-token and suppression tests**

Add these reconciliation tests:

```ts
it("starts a new daily attempt when source versions are unchanged", async () => {
	publishCurrentSources(
		"today",
		new Date(2026, 7, 20, 9, 0, 0).toISOString(),
	);
	const install = vi.fn(async () => ({ ok: true }) as LaunchAgentInstallResult);
	const first = await reconcilePeriodDigestFreshness({
		period: "today",
		now: new Date(2026, 7, 20, 10, 0, 0),
		freshnessSeconds: 60 * 60,
		schedule: { hour: 8, minute: 0 },
		install,
	});
	await writePeriodDigestFreshnessState({
		...first.state,
		status: "consumed",
		consumedAt: new Date(2026, 7, 20, 10, 1, 0).toISOString(),
		completedAt: new Date(2026, 7, 20, 10, 1, 0).toISOString(),
	});
	install.mockClear();

	const second = await reconcilePeriodDigestFreshness({
		period: "today",
		now: new Date(2026, 7, 21, 8, 30, 0),
		freshnessSeconds: 60 * 60,
		schedule: { hour: 8, minute: 0 },
		install,
	});

	expect(second.state).toMatchObject({
		status: "scheduled",
		dueAt: new Date(2026, 7, 21, 9, 0, 0).toISOString(),
	});
	expect(second.state.attemptToken).not.toBe(first.state.attemptToken);
	expect(install).toHaveBeenCalledOnce();
});

it("does not inherit source suppressions from an earlier local day", async () => {
	publishCurrentSources(
		"24h",
		new Date(2026, 7, 20, 9, 0, 0).toISOString(),
	);
	const sourceIdentities = {
		all: "stable-all",
		following: "stable-following",
		for_you: "stable-for_you",
	};
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "24h",
		attemptToken: "previous-cycle",
		dueAt: new Date(2026, 7, 20, 12, 0, 0).toISOString(),
		fireAt: "",
		status: "disabled",
		updatedAt: new Date(2026, 7, 20, 23, 0, 0).toISOString(),
		freshnessSeconds: 60 * 60,
		sourceIdentities,
		suppressedSourceIdentities: sourceIdentities,
	});
	const install = vi.fn(async () => ({ ok: true }) as LaunchAgentInstallResult);

	const reconciled = await reconcilePeriodDigestFreshness({
		period: "24h",
		now: new Date(2026, 7, 21, 8, 30, 0),
		freshnessSeconds: 60 * 60,
		schedule: { hour: 8, minute: 0 },
		install,
	});

	expect(reconciled.state).toMatchObject({
		status: "scheduled",
		dueAt: new Date(2026, 7, 21, 9, 0, 0).toISOString(),
		suppressedSourceIdentities: {},
	});
	expect(install).toHaveBeenCalledOnce();
});
```

- [x] **Step 3: Run both tests and verify RED**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-freshness.test.ts -t "new daily attempt|does not inherit source suppressions"
```

Expected: the first test returns the previous consumed attempt; the second remains disabled because all source identities stay suppressed.

- [x] **Step 4: Add the shared state-cycle helpers**

Add after `sameLocalDay`:

```ts
function freshnessStateCycleDate(state: PeriodDigestFreshnessStateV1) {
	const dueAt = new Date(state.dueAt);
	return Number.isFinite(dueAt.getTime()) ? dueAt : new Date(state.updatedAt);
}

function isEarlierLocalDay(left: Date, right: Date) {
	const leftDay = new Date(left);
	leftDay.setHours(0, 0, 0, 0);
	const rightDay = new Date(right);
	rightDay.setHours(0, 0, 0, 0);
	return (
		Number.isFinite(leftDay.getTime()) &&
		Number.isFinite(rightDay.getTime()) &&
		leftDay.getTime() < rightDay.getTime()
	);
}

function freshnessStateIsFromEarlierLocalDay(
	state: PeriodDigestFreshnessStateV1,
	now: Date,
) {
	return isEarlierLocalDay(freshnessStateCycleDate(state), now);
}
```

- [x] **Step 5: Scope suppression inheritance and token identity to the daily cycle**

Before `suppressedSourceIdentities`, calculate:

```ts
const previousIsSameCycle = Boolean(
	previous && sameLocalDay(freshnessStateCycleDate(previous), calculationNow),
);
```

Change the inherited identity condition to:

```ts
const previousIdentity =
	previousIsSameCycle && previous?.freshnessSeconds === freshnessSeconds
		? previous.suppressedSourceIdentities?.[contentSource]
		: undefined;
```

Add the cycle base to the token hash input:

```ts
cycleBase: scheduledBase.toISOString(),
```

- [x] **Step 6: Preserve same-cycle suppression behavior**

Add this passing characterization test:

```ts
it("retains source suppressions within the same local day", async () => {
	publishCurrentSources(
		"today",
		new Date(2026, 7, 20, 9, 0, 0).toISOString(),
	);
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "today",
		attemptToken: "same-cycle",
		dueAt: new Date(2026, 7, 20, 10, 0, 0).toISOString(),
		fireAt: new Date(2026, 7, 20, 10, 0, 0).toISOString(),
		status: "scheduled",
		updatedAt: new Date(2026, 7, 20, 9, 30, 0).toISOString(),
		freshnessSeconds: 60 * 60,
		sourceIdentities: {
			all: "stable-all",
			following: "stable-following",
			for_you: "stable-for_you",
		},
		suppressedSourceIdentities: { all: "stable-all" },
	});

	const reconciled = await reconcilePeriodDigestFreshness({
		period: "today",
		now: new Date(2026, 7, 20, 10, 0, 0),
		freshnessSeconds: 60 * 60,
		schedule: { hour: 8, minute: 0 },
		install: vi.fn(async () => ({ ok: true }) as LaunchAgentInstallResult),
	});

	expect(reconciled.state.suppressedSourceIdentities).toEqual({
		all: "stable-all",
	});
});
```

- [x] **Step 7: Verify GREEN and the reconciliation lifecycle suite**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-freshness.test.ts -t "daily attempt|source suppressions|stable token|lifecycle"
```

Expected: all selected tests PASS.

- [x] **Step 8: Commit the daily-cycle behavior**

```bash
git add src/lib/period-digest-freshness.ts src/lib/period-digest-freshness.test.ts
git commit -m "fix: scope freshness attempts to local day"
```

### Task 3: Rebuild Stale State at the Page and CLI Trigger Boundary

**Files:**
- Modify: `src/lib/period-digest-freshness.test.ts:640-860`
- Modify: `src/lib/period-digest-freshness.ts:849-899`

- [x] **Step 1: Write failing stale-state trigger tests**

Add a parameterized test that writes both an old valid `dueAt` state and an old disabled `dueAt: ""` state, then calls `triggerDuePeriodDigestFreshness` with `now = 2026-08-21 08:00`. Pass the inferred input through a variable so the optional `reconcile` dependency is present at runtime before the production signature is extended:

```ts
it.each([
	{ label: "cross-day dueAt", dueAt: new Date(2026, 7, 20, 11, 30, 0).toISOString() },
	{ label: "disabled state", dueAt: "" },
])("rebuilds an earlier $label before checking eligibility", async ({ dueAt }) => {
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "24h",
		attemptToken: "old-cycle-token",
		dueAt,
		fireAt: "",
		status: dueAt ? "scheduled" : "disabled",
		updatedAt: new Date(2026, 7, 20, 23, 0, 0).toISOString(),
	});
	const install = vi.fn(async () => ({ ok: true }) as LaunchAgentInstallResult);
	const reconcile = vi.fn(
		(input: Parameters<typeof reconcilePeriodDigestFreshness>[0]) =>
			reconcilePeriodDigestFreshness({
				...input,
				freshnessSeconds: 4 * 60 * 60,
				schedule: { hour: 7, minute: 30 },
				install,
			}),
	);
	const requestRun = vi.fn();
	const input = {
		period: "24h" as const,
		origin: "page" as const,
		now: new Date(2026, 7, 21, 8, 0, 0),
		requestRun,
		reconcile,
	};

	await expect(triggerDuePeriodDigestFreshness(input)).resolves.toEqual({
		triggered: false,
		reason: "not-due",
		eligibleAt: new Date(2026, 7, 21, 11, 30, 0).toISOString(),
	});
	expect(reconcile).toHaveBeenCalledOnce();
	expect(install).toHaveBeenCalledOnce();
	expect(requestRun).not.toHaveBeenCalled();
	await expect(
		consumePeriodDigestFreshnessAttempt({
			period: "24h",
			attemptToken: "old-cycle-token",
			origin: "launchd",
			now: new Date(2026, 7, 21, 8, 1, 0),
		}),
	).resolves.toMatchObject({ valid: false, reason: "token-mismatch" });
});
```

Add the running-state branch:

```ts
it("does not loop when an active cross-day run prevents rebuilding", async () => {
	const previous: PeriodDigestFreshnessStateV1 = {
		schemaVersion: 1,
		period: "today",
		attemptToken: "running-old-cycle",
		dueAt: new Date(2026, 7, 20, 23, 30, 0).toISOString(),
		fireAt: new Date(2026, 7, 20, 23, 30, 0).toISOString(),
		status: "running",
		startedAt: new Date(2026, 7, 21, 0, 1, 0).toISOString(),
		updatedAt: new Date(2026, 7, 21, 0, 1, 0).toISOString(),
	};
	await writePeriodDigestFreshnessState(previous);
	const install = vi.fn(async () => ({ ok: true }) as LaunchAgentInstallResult);
	const reconcile = vi.fn(
		(input: Parameters<typeof reconcilePeriodDigestFreshness>[0]) =>
			reconcilePeriodDigestFreshness({
				...input,
				freshnessSeconds: 4 * 60 * 60,
				schedule: { hour: 7, minute: 0 },
				install,
			}),
	);
	const requestRun = vi.fn();
	const input = {
		period: "today" as const,
		origin: "page" as const,
		now: new Date(2026, 7, 21, 0, 5, 0),
		requestRun,
		reconcile,
	};

	await expect(triggerDuePeriodDigestFreshness(input)).resolves.toEqual({
		triggered: false,
		reason: "cross-day",
	});
	expect(reconcile).toHaveBeenCalledOnce();
	expect(install).not.toHaveBeenCalled();
	expect(requestRun).not.toHaveBeenCalled();
});
```

Add the overdue path:

```ts
it("starts one overdue daily baseline after rebuilding stale disabled state", async () => {
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "24h",
		attemptToken: "disabled-old-cycle",
		dueAt: "",
		fireAt: "",
		status: "disabled",
		updatedAt: new Date(2026, 7, 20, 23, 0, 0).toISOString(),
	});
	const install = vi.fn(async () => ({ ok: true }) as LaunchAgentInstallResult);
	const reconcile = vi.fn(
		(input: Parameters<typeof reconcilePeriodDigestFreshness>[0]) =>
			reconcilePeriodDigestFreshness({
				...input,
				freshnessSeconds: 4 * 60 * 60,
				schedule: { hour: 7, minute: 30 },
				install,
			}),
	);
	const requestRun = vi.fn(async () => ({
		runId: "overdue-run",
		joined: false,
		completion: new Promise<{ phase: "completed" }>(() => undefined),
	}));
	const input = {
		period: "24h" as const,
		origin: "page" as const,
		now: new Date(2026, 7, 21, 12, 0, 0),
		requestRun,
		reconcile,
	};

	await expect(triggerDuePeriodDigestFreshness(input)).resolves.toMatchObject({
		triggered: true,
		runId: "overdue-run",
	});
	await expect(triggerDuePeriodDigestFreshness(input)).resolves.toMatchObject({
		triggered: false,
		reason: "already-running",
	});
	expect(reconcile).toHaveBeenCalledOnce();
	expect(install).toHaveBeenCalledOnce();
	expect(requestRun).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Run the trigger tests and verify RED**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-freshness.test.ts -t "rebuilds an earlier|running cross-day|overdue daily baseline"
```

Expected: stale states return `disabled` or `cross-day` without invoking the injected reconciliation.

- [x] **Step 3: Inject reconciliation and rebuild only earlier cycles**

Extend the trigger input with:

```ts
reconcile = reconcilePeriodDigestFreshness,
```

and its type with:

```ts
reconcile?: typeof reconcilePeriodDigestFreshness;
```

Replace the missing-state-only branch with:

```ts
if (!state || freshnessStateIsFromEarlierLocalDay(state, effectiveNow)) {
	state = (
		await reconcile({
			period,
			now: effectiveNow,
			clock: currentTime,
		})
	).state;
}
```

Do not retry reconciliation if it returns the old running state. Continue through the existing disabled and consume checks once, so `cross-day` or `already-running` remains authoritative.

- [x] **Step 4: Preserve current-day and future disabled states**

Add this passing characterization after the production change:

```ts
it.each([
	{ label: "current", updatedAt: new Date(2026, 7, 21, 8, 0, 0) },
	{ label: "future", updatedAt: new Date(2026, 7, 22, 8, 0, 0) },
])("does not rebuild a $label-day disabled state", async ({ updatedAt }) => {
	await writePeriodDigestFreshnessState({
		schemaVersion: 1,
		period: "today",
		attemptToken: `${updatedAt.toISOString()}-disabled`,
		dueAt: "",
		fireAt: "",
		status: "disabled",
		updatedAt: updatedAt.toISOString(),
	});
	const reconcile = vi.fn();
	const input = {
		period: "today" as const,
		origin: "page" as const,
		now: new Date(2026, 7, 21, 9, 0, 0),
		reconcile,
	};

	await expect(triggerDuePeriodDigestFreshness(input)).resolves.toEqual({
		triggered: false,
		reason: "disabled",
	});
	expect(reconcile).not.toHaveBeenCalled();
});
```

- [x] **Step 5: Verify GREEN and existing trigger behavior**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-freshness.test.ts -t "page|trigger|cross-day|disabled|overdue|running"
```

Expected: all selected tests PASS. The new page path invokes direct installation once; no deferred reloader is introduced.

- [x] **Step 6: Commit the trigger boundary fix**

```bash
git add src/lib/period-digest-freshness.ts src/lib/period-digest-freshness.test.ts
git commit -m "fix: rebuild daily freshness on page trigger"
```

### Task 4: Preserve Recovery After a Scheduled All-Source Failure

**Files:**
- Modify: `src/lib/period-digest-orchestrator.test.ts:782-805`
- Modify: `src/lib/period-digest-orchestrator.ts:879-894`

- [x] **Step 1: Change the scheduled all-failure expectation and add symmetric trigger tests**

Rename the existing test to `reconciles the daily baseline when every scheduled source fails` and replace its final assertion with:

```ts
expect(deps.reconcileFreshness).toHaveBeenCalledWith("today", {
	replaceRunningAttempt: true,
});
```

Use a resolving reconciliation mock so the expected call is observable:

```ts
reconcileFreshness: vi.fn(async () => undefined),
```

Add this symmetric test:

```ts
it.each(["freshness", "manual"] as const)(
	"does not replace freshness state when every %s source fails",
	async (trigger) => {
		const deps = dependencies({
			generate: vi.fn(async () =>
				Promise.reject(new Error("model unavailable")),
			),
		});
		const run = await requestPeriodDigestRun(
			{ period: "today", trigger, origin: "cli" },
			deps,
		);

		expect((await run.completion).phase).toBe("failed");
		expect(deps.reconcileFreshness).not.toHaveBeenCalled();
	},
);
```

- [x] **Step 2: Run the orchestrator tests and verify RED**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-orchestrator.test.ts -t "every scheduled source fails|every freshness source fails|every manual source fails"
```

Expected: scheduled case FAILS because reconciliation is not called; freshness and manual characterization cases PASS.

- [x] **Step 3: Reconcile scheduled failures without suppressing unchanged sources**

Replace the reconciliation guard with:

```ts
if (completedSources > 0 || request.trigger === "scheduled") {
	const suppressSources =
		completedSources > 0
			? DEFAULT_SOURCE_ORDER.filter(
					(contentSource) =>
						finalState.sources[contentSource].state === "failed",
				)
			: [];
```

Keep the existing options construction. Because the scheduled all-failure branch has an empty `suppressSources`, it sends only `{ replaceRunningAttempt: true }`. Freshness all-failure remains outside the guard and continues through completion retry handling.

- [x] **Step 4: Verify GREEN and partial-success options**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-orchestrator.test.ts -t "every scheduled source fails|every freshness source fails|every manual source fails|invalid results|defers next-generation"
```

Expected: all selected tests PASS; partial failures still pass `suppressSources`, and launchd freshness success still passes `deferLaunchAgentReload`.

- [x] **Step 5: Commit the scheduled recovery path**

```bash
git add src/lib/period-digest-orchestrator.ts src/lib/period-digest-orchestrator.test.ts
git commit -m "fix: retain freshness after scheduled failure"
```

### Task 5: Full Verification and PR Update

**Files:**
- Verify: `docs/superpowers/specs/2026-08-22-issue-62-cross-midnight-freshness-design.md`
- Verify: `src/lib/period-digest-freshness.ts`
- Verify: `src/lib/period-digest-freshness.test.ts`
- Verify: `src/lib/period-digest-orchestrator.ts`
- Verify: `src/lib/period-digest-orchestrator.test.ts`

- [x] **Step 1: Run both focused suites**

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-freshness.test.ts src/lib/period-digest-orchestrator.test.ts
```

Expected: all freshness and orchestrator tests PASS.

- [x] **Step 2: Run the complete test suite**

```bash
corepack pnpm run test
```

Expected: all test files and tests PASS.

- [x] **Step 3: Run repository quality checks separately**

The host has a non-standard `pnpm` wrapper, so invoke each aggregate component through Corepack:

```bash
corepack pnpm run format:check
corepack pnpm run lint
corepack pnpm run typecheck
```

Expected: formatting clean, lint has zero warnings, typecheck exits 0.

- [x] **Step 4: Inspect the final patch**

```bash
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, clean worktree, and only Issue #62 design/implementation commits.

- [x] **Step 5: Push and update PR #63**

```bash
git push
gh pr comment 63 --body "Implementation added with red/green coverage for the daily deadline floor, cycle token and suppression reset, stale trigger reconciliation, and scheduled all-source failure recovery. Full verification results are recorded in the latest commits."
```

Expected: PR #63 points at the final implementation commit and CI starts for the new head.

### Task 6: Reconcile Scheduled Batch-Level Failures

**Files:**
- Modify: `src/lib/period-digest-orchestrator.test.ts`
- Modify: `src/lib/period-digest-orchestrator.ts`

- [x] **Step 1: Write the failing scheduled pre-sync test**

Add a scheduled counterpart to the existing pre-sync failure test:

```ts
it("reconciles the daily baseline when scheduled pre-sync fails", async () => {
	const deps = dependencies({
		preSync: vi.fn(async () => Promise.reject(new Error("sync unavailable"))),
	});
	const run = await requestPeriodDigestRun(
		{ period: "24h", trigger: "scheduled", origin: "launchd" },
		deps,
	);

	expect((await run.completion).phase).toBe("failed");
	expect(deps.reconcileFreshness).toHaveBeenCalledWith("24h", {
		replaceRunningAttempt: true,
	});
});
```

- [x] **Step 2: Verify RED**

Run:

```bash
node ./scripts/run-vitest.mjs run src/lib/period-digest-orchestrator.test.ts -t "scheduled pre-sync fails"
```

Expected: FAIL because the catch branch never calls `reconcileFreshness`.

- [x] **Step 3: Reconcile only after the failed state is owned and persisted**

Inside `if (failed)`, before audit, add:

```ts
if (request.trigger === "scheduled") {
	const reconciliation = dependencies.reconcileFreshness?.(request.period, {
		replaceRunningAttempt: true,
	});
	await reconciliation?.catch(() => undefined);
}
```

Keeping this inside `if (failed)` prevents an owner that lost its lease from rebuilding freshness.

- [x] **Step 4: Verify GREEN**

Run the scheduled pre-sync and all-source failure tests. Expected: both PASS.

### Task 7: Recover Invalid Cycles and Contain Trigger Reconciliation Errors

**Files:**
- Modify: `src/lib/period-digest-freshness.test.ts`
- Modify: `src/lib/period-digest-freshness.ts`

- [ ] **Step 1: Write failing invalid-cycle and reconciliation-error tests**

Add one test with `dueAt: "invalid"` and `updatedAt: "invalid"` that injects real
reconciliation and expects today's `not-due` baseline. Add a second earlier-day state whose injected
reconciliation rejects and expect:

```ts
{
	triggered: false,
	reason: "reconcile-error",
}
```

Both tests must assert `requestRun` was not called.

- [ ] **Step 2: Verify RED**

Run both new tests. Expected: invalid state returns `cross-day`; reconciliation rejection escapes.

- [ ] **Step 3: Treat an unparseable cycle as stale**

Change the helper to:

```ts
function freshnessStateIsFromEarlierLocalDay(
	state: PeriodDigestFreshnessStateV1,
	now: Date,
) {
	const cycleDate = freshnessStateCycleDate(state);
	return (
		!Number.isFinite(cycleDate.getTime()) || isEarlierLocalDay(cycleDate, now)
	);
}
```

- [ ] **Step 4: Catch reconciliation failures at the trigger boundary**

Wrap only the reconciliation call in `try/catch`; on failure return
`{ triggered: false as const, reason: "reconcile-error" as const }`. Do not consume the old state.

- [ ] **Step 5: Verify GREEN and existing trigger behavior**

Run the invalid-cycle, reconciliation-error, earlier-state, disabled, and running trigger tests.
Expected: all PASS.

### Task 8: Cover the Clamped Cross-Midnight Deadline

**Files:**
- Modify: `src/lib/period-digest-freshness.test.ts`

- [ ] **Step 1: Add the missing deadline test**

```ts
it("returns null when the clamped daily baseline crosses midnight", () => {
	const due = calculatePeriodDigestFreshnessDeadline({
		now: new Date(2026, 7, 6, 20, 0, 0),
		freshnessSeconds: 4 * 60 * 60,
		schedule: { hour: 21, minute: 0 },
		generatedAt: {
			all: new Date(2026, 7, 6, 20, 30, 0).toISOString(),
		},
	});

	expect(due).toBeNull();
});
```

- [ ] **Step 2: Verify the characterization test passes**

Run the deadline tests. Expected: PASS; this is coverage for already-approved behavior, not a
production change.

### Task 9: Final Verification and PR Follow-Up

- [ ] **Step 1:** Run both complete focused suites.
- [ ] **Step 2:** Run the full test suite.
- [ ] **Step 3:** Run format, lint, and typecheck separately through Corepack.
- [ ] **Step 4:** Inspect the final diff and clean worktree, then commit and push.
- [ ] **Step 5:** Reply to the latest PR review with each residual item's implementation and CI result.
