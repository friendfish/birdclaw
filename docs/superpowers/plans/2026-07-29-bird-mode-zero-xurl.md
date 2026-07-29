# Bird Mode Zero-xurl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that an operation resolved to Bird never probes, invokes, or falls back to xurl while preserving `auto` fallback and explicit xurl behavior.

**Architecture:** Add a small live-read transport policy module that resolves explicit argument, environment, config, and each caller's legacy default once. Orchestrators pass the resolved mode through every sub-step, and passive status consumers synthesize a disabled xurl status in Bird mode instead of calling the xurl adapter.

**Tech Stack:** TypeScript, Effect, Vitest, Commander, Node subprocess adapters, SQLite-backed integration tests.

---

## Execution Note

Use commit `d130ce8` as the implementation baseline; it contains the user's prompt-template, profile-analysis, search-discussion, and digest-reliability work that this fix must preserve. Recheck `git status --short` before every commit. If new overlapping user changes appear during execution, stage only this plan's exact hunks or skip that commit rather than absorbing unrelated work.

## File Map

- Create `src/lib/live-transport-policy.ts`: resolve the effective live-read mode and build stable disabled-xurl status values.
- Create `src/lib/live-transport-policy.test.ts`: verify precedence and legacy-default behavior.
- Modify `src/lib/period-digest.ts`: propagate Bird through timeline, mentions, and mention-thread refreshes.
- Modify `src/lib/period-digest-request.ts`: use shared mode resolution for web requests.
- Modify `src/cli/register-analysis.ts`: use shared mode resolution for digest CLI defaults.
- Modify `src/lib/period-digest-live.test.ts`, `src/routes/api/period-digest.test.ts`, `src/routes/api/period-digest-metadata.test.ts`, and `src/cli.test.ts`: cover Bird propagation and default resolution.
- Modify `src/lib/profile-resolver.ts`: disable implicit xurl fallback in configured Bird mode.
- Modify `src/lib/profile-hydration.ts`: skip xurl status probing in configured Bird mode.
- Modify `src/lib/profile-resolver.test.ts` and `src/lib/profile-hydration.test.ts`: prove Bird misses/errors do not call xurl.
- Modify `src/lib/data-sources.ts`: synthesize xurl-disabled source status in Bird mode.
- Create `src/lib/data-sources.test.ts`: prove passive Bird availability checks do not probe xurl.
- Modify `src/lib/query-status.ts` and `src/lib/queries.test.ts`: skip shared-envelope xurl status checks in Bird mode.
- Modify `src/lib/profile-analysis.ts`, `src/routes/api/profile-analysis.tsx`, and their tests: choose the existing Bird profile/timeline/thread path without probing xurl while retaining an explicit mode override.
- Modify `src/lib/search-discussion.ts`, `src/routes/api/search-discussion.tsx`, `src/cli/register-analysis.ts`, and `src/lib/route-search.ts`: remove implicit xurl defaults from Discuss.
- Modify `src/lib/authored-live.ts`, `src/cli/register-sync.ts`, `src/cli.test.ts`, and `src/lib/authored-live.test.ts`: require explicit xurl for the xurl-only authored sync when Bird is configured.
- Modify `src/lib/blocks.ts` and `src/lib/blocks.test.ts`: skip remote xurl block sync before probing when Bird actions are selected.
- Modify `src/lib/account-sync-job.ts` and `src/lib/account-sync-job.test.ts`: propagate Bird to scheduled mention-thread work and configured defaults.

### Task 1: Central Live-read Transport Policy

**Files:**
- Create: `src/lib/live-transport-policy.ts`
- Create: `src/lib/live-transport-policy.test.ts`

- [ ] **Step 1: Write the failing policy tests**

```typescript
// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resetBirdclawPathsForTests,
	writeBirdclawConfig,
} from "./config";
import {
	resolveLiveReadMode,
	xurlDisabledDataSourceStatus,
	xurlDisabledTransportStatus,
} from "./live-transport-policy";

let root = "";

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
	resetBirdclawPathsForTests();
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("live transport policy", () => {
	it("resolves explicit mode before configured Bird mode", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		resetBirdclawPathsForTests();
		writeBirdclawConfig({ mentions: { dataSource: "bird" } });

		expect(resolveLiveReadMode()).toBe("bird");
		expect(resolveLiveReadMode("auto")).toBe("auto");
		expect(resolveLiveReadMode("xurl")).toBe("xurl");
	});

	it("keeps the legacy live default for local-only configuration", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		resetBirdclawPathsForTests();

		expect(resolveLiveReadMode()).toBe("xurl");
		expect(resolveLiveReadMode(undefined, "auto")).toBe("auto");
	});

	it("builds stable disabled xurl statuses", () => {
		expect(xurlDisabledTransportStatus()).toEqual({
			installed: false,
			availableTransport: "local",
			statusText: "xurl disabled by bird transport selection",
		});
		expect(xurlDisabledDataSourceStatus()).toMatchObject({
			source: "xurl",
			works: false,
			status: "warning",
			accounts: [],
		});
	});
});
```

- [ ] **Step 2: Run the policy test and verify RED**

Run: `pnpm test -- src/lib/live-transport-policy.test.ts`

Expected: FAIL because `./live-transport-policy` does not exist.

- [ ] **Step 3: Implement the policy module**

```typescript
import {
	resolveMentionsDataSource,
	type MentionsDataSource,
} from "./config";
import type { LiveDataSourceStatus, TransportStatus } from "./types";

export type LiveReadMode = Exclude<MentionsDataSource, "birdclaw">;

export function resolveLiveReadMode(
	requestedMode?: string,
	legacyDefault: LiveReadMode = "xurl",
): LiveReadMode {
	const source = resolveMentionsDataSource(requestedMode);
	return source === "birdclaw" ? legacyDefault : source;
}

export function xurlDisabledTransportStatus(): TransportStatus {
	return {
		installed: false,
		availableTransport: "local",
		statusText: "xurl disabled by bird transport selection",
	};
}

export function xurlDisabledDataSourceStatus(): LiveDataSourceStatus {
	return {
		source: "xurl",
		label: "xurl",
		works: false,
		status: "warning",
		detail: "xurl disabled by bird transport selection",
		accounts: [],
	};
}
```

- [ ] **Step 4: Run the policy test and verify GREEN**

Run: `pnpm test -- src/lib/live-transport-policy.test.ts`

Expected: PASS with 3 tests.

- [ ] **Step 5: Commit only the policy files when safe**

```bash
git add src/lib/live-transport-policy.ts src/lib/live-transport-policy.test.ts
git commit -m "fix: centralize live read transport policy"
```

### Task 2: Propagate Bird Through Period Digests and Defaults

**Files:**
- Modify: `src/lib/period-digest.ts:745-934`
- Modify: `src/lib/period-digest-request.ts:1-53`
- Modify: `src/cli/register-analysis.ts:1-108`
- Modify: `src/lib/period-digest-live.test.ts:265-356`
- Modify: `src/routes/api/period-digest.test.ts:1-132`
- Modify: `src/routes/api/period-digest-metadata.test.ts:1-95`
- Modify: `src/cli.test.ts:1-100,318-430,2760-2835`

- [ ] **Step 1: Extend the existing Bird override test to cover every digest sub-step**

Add these assertions to `respects an explicit liveSyncMode override for non-for_you content sources`:

```typescript
expect(syncHomeTimelineMock.mock.calls[0]?.[0]).toMatchObject({
	following: true,
	mode: "bird",
});
expect(syncMentionsMock.mock.calls[0]?.[0]).toMatchObject({ mode: "bird" });
expect(syncMentionThreadsMock.mock.calls.at(-1)?.[0]).toMatchObject({
	mode: "bird",
});
```

Update the route config mocks to export `resolveLiveReadMode: () => "bird"`, change the route expectations from `liveSyncMode: "xurl"` to `liveSyncMode: "bird"`, and add a hoisted `resolveLiveReadModeMock` to `src/cli.test.ts` that returns `"bird"` for the digest-default assertion.

- [ ] **Step 2: Run the digest tests and verify RED**

Run: `pnpm test -- src/lib/period-digest-live.test.ts src/routes/api/period-digest.test.ts src/routes/api/period-digest-metadata.test.ts src/cli.test.ts`

Expected: FAIL because mentions and mention threads receive `xurl`, while API/CLI defaults do not call the shared resolver.

- [ ] **Step 3: Resolve once and propagate the mode**

In `period-digest-request.ts` replace the direct config check with:

```typescript
import { resolveLiveReadMode } from "./live-transport-policy";

// inside parsePeriodDigestRequestOptions
liveSyncMode: resolveLiveReadMode(),
```

In `register-analysis.ts` resolve only an omitted mode through policy and keep rejecting invalid explicit values:

```typescript
import { resolveLiveReadMode } from "#/lib/live-transport-policy";

if (value === undefined) return resolveLiveReadMode();
const normalized = value.trim().toLowerCase();
if (
	normalized === "auto" ||
	normalized === "bird" ||
	normalized === "xurl"
) {
	return normalized;
}
printError("--live-mode must be auto, bird, or xurl");
process.exitCode = 1;
return undefined;
```

In `refreshPeriodDigestInputsEffect`, calculate distinct timeline and thread modes without overriding Bird:

```typescript
const liveMode = options.liveSyncMode ?? resolveLiveReadMode();
const timelineFollowing = options.contentSource !== "for_you";
const timelineMode = timelineFollowing
	? liveMode
	: liveMode === "bird"
		? "bird"
		: "auto";
const mentionThreadMode = liveMode === "bird" ? "bird" : "xurl";
```

Then pass `timelineMode` to `syncHomeTimelineEffect`, `liveMode` to `syncMentionsEffect`, and `mentionThreadMode` to `syncMentionThreadsEffect`. Replace `Walking the selected time window with xurl.` with a source-neutral detail such as `Walking the selected time window with ${timelineMode}.`.

- [ ] **Step 4: Run the digest tests and verify GREEN**

Run: `pnpm test -- src/lib/period-digest-live.test.ts src/routes/api/period-digest.test.ts src/routes/api/period-digest-metadata.test.ts src/cli.test.ts`

Expected: PASS; explicit Bird reaches all three sub-steps, configured defaults are Bird, and existing explicit xurl/auto cases remain green.

- [ ] **Step 5: Commit the digest-policy files when the worktree still matches the baseline**

```bash
git add src/lib/period-digest.ts src/lib/period-digest-request.ts src/cli/register-analysis.ts src/lib/period-digest-live.test.ts src/routes/api/period-digest.test.ts src/routes/api/period-digest-metadata.test.ts src/cli.test.ts
git commit -m "fix: keep digest live refreshes on bird"
```

### Task 3: Disable Profile xurl Fallback in Bird Mode

**Files:**
- Modify: `src/lib/profile-resolver.ts:43-48,271-280,422-428`
- Modify: `src/lib/profile-hydration.ts:19-24,168-184`
- Modify: `src/lib/profile-resolver.test.ts`
- Modify: `src/lib/profile-hydration.test.ts`

- [ ] **Step 1: Write failing no-fallback tests**

Add to `profile-resolver.test.ts`:

```typescript
it("does not fall back to xurl for handle misses in Bird mode", async () => {
	process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
	resetBirdclawPathsForTests();
	mocks.lookupProfilesViaBird.mockResolvedValueOnce([
		{ target: "missing", user: null },
	]);
	const { resolveProfilesForHandles } = await import("./profile-resolver");

	await expect(resolveProfilesForHandles(["missing"])).resolves.toEqual([
		expect.objectContaining({
			handle: "missing",
			status: "miss",
			source: "bird",
		}),
	]);
	expect(mocks.lookupUsersByHandles).not.toHaveBeenCalled();
});
```

Delete `BIRDCLAW_MENTIONS_DATA_SOURCE` in that file's `afterEach`. Add to `profile-hydration.test.ts`:

```typescript
it("does not probe xurl before Bird-only bulk hydration", async () => {
	process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
	resetBirdclawPathsForTests();
	mocks.getAuthenticatedBirdAccount.mockRejectedValueOnce(
		new Error("bird unavailable"),
	);
	const { hydrateProfilesFromX } = await import("./profile-hydration");

	await expect(hydrateProfilesFromX()).resolves.toMatchObject({
		hydratedProfiles: 0,
		hydratedAccount: false,
		reason: "xurl disabled by bird transport selection",
	});
	expect(mocks.getTransportStatus).not.toHaveBeenCalled();
	expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run profile tests and verify RED**

Run: `pnpm test -- src/lib/profile-resolver.test.ts src/lib/profile-hydration.test.ts`

Expected: FAIL because resolver defaults `xurlFallback` to true and bulk hydration calls `getTransportStatusEffect`.

- [ ] **Step 3: Derive fallback and bulk behavior from policy**

Import `resolveLiveReadMode` and use it in both resolver entry points:

```typescript
const xurlFallback =
	options.xurlFallback ?? resolveLiveReadMode() !== "bird";
```

At the start of `hydrateProfilesFromXEffect`, before `getTransportStatusEffect`, add:

```typescript
if (resolveLiveReadMode() === "bird") {
	const hydratedAccount = yield* hydrateAccountFromBirdEffect(account);
	return {
		ok: true,
		hydratedProfiles: 0,
		hydratedAccount,
		reason: "xurl disabled by bird transport selection",
	};
}
```

This keeps explicit `xurlFallback: true` behavior intact and preserves current auto/xurl behavior.

- [ ] **Step 4: Run profile tests and verify GREEN**

Run: `pnpm test -- src/lib/profile-resolver.test.ts src/lib/profile-hydration.test.ts src/lib/profile-hydration-client.test.ts`

Expected: PASS; Bird miss/error tests report Bird results and every xurl mock stays untouched.

- [ ] **Step 5: Commit profile policy changes when safe**

```bash
git add src/lib/profile-resolver.ts src/lib/profile-resolver.test.ts src/lib/profile-hydration.ts src/lib/profile-hydration.test.ts
git commit -m "fix: disable profile xurl fallback in bird mode"
```

### Task 4: Remove Passive xurl Status Probes

**Files:**
- Modify: `src/lib/data-sources.ts:1-217`
- Create: `src/lib/data-sources.test.ts`
- Modify: `src/lib/query-status.ts:1-190`
- Modify: `src/lib/queries.test.ts:177-194,2196-2220`

- [ ] **Step 1: Write a failing data-source status test**

```typescript
// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAuthenticatedBirdAccount: vi.fn(),
	getTransportStatus: vi.fn(),
	lookupAuthenticatedOAuth2User: vi.fn(),
	readXurlOAuth2Accounts: vi.fn(),
}));

vi.mock("./bird", async () => {
	const { effectFromMock } = await import("../test/effect-mocks");
	return {
		getAuthenticatedBirdAccountEffect: effectFromMock(
			mocks.getAuthenticatedBirdAccount,
		),
	};
});
vi.mock("./xurl", async () => {
	const { effectFromMock } = await import("../test/effect-mocks");
	return {
		getTransportStatusEffect: effectFromMock(mocks.getTransportStatus),
		lookupAuthenticatedOAuth2UserEffect: effectFromMock(
			mocks.lookupAuthenticatedOAuth2User,
		),
		readXurlOAuth2AccountsEffect: effectFromMock(
			mocks.readXurlOAuth2Accounts,
		),
	};
});
vi.mock("./db", () => ({
	getNativeDb: () => ({
		prepare: () => ({ all: () => [] }),
	}),
}));

describe("data source status", () => {
	beforeEach(() => {
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({ username: "tester" });
	});
	afterEach(() => {
		delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
		vi.clearAllMocks();
	});

	it("reports xurl disabled without probing it in Bird mode", async () => {
		const { getLiveDataSourcesEffect } = await import("./data-sources");
		const result = await Effect.runPromise(getLiveDataSourcesEffect());

		expect(result.sources).toContainEqual(
			expect.objectContaining({
				source: "xurl",
				works: false,
				detail: "xurl disabled by bird transport selection",
			}),
		);
		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
		expect(mocks.lookupAuthenticatedOAuth2User).not.toHaveBeenCalled();
		expect(mocks.readXurlOAuth2Accounts).not.toHaveBeenCalled();
	});

	it("still probes xurl when xurl is explicitly configured", async () => {
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "xurl";
		mocks.getTransportStatus.mockResolvedValue({
			installed: true,
			availableTransport: "xurl",
			statusText: "xurl available",
		});
		mocks.readXurlOAuth2Accounts.mockResolvedValue([]);
		mocks.lookupAuthenticatedOAuth2User.mockResolvedValue(null);
		const { getLiveDataSourcesEffect } = await import("./data-sources");

		await Effect.runPromise(getLiveDataSourcesEffect());

		expect(mocks.getTransportStatus).toHaveBeenCalledTimes(1);
		expect(mocks.readXurlOAuth2Accounts).toHaveBeenCalledTimes(1);
	});
});
```

Add a query-envelope test:

```typescript
it("does not probe xurl for the status envelope in Bird mode", async () => {
	setupTempHome();
	process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
	resetBirdclawPathsForTests();

	await expect(
		Effect.runPromise(getQueryEnvelopeEffect({ includeArchives: false })),
	).resolves.toMatchObject({
		transport: {
			availableTransport: "local",
			statusText: "xurl disabled by bird transport selection",
		},
	});
	expect(mocks.getTransportStatus).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run passive-status tests and verify RED**

Run: `pnpm test -- src/lib/data-sources.test.ts src/lib/queries.test.ts`

Expected: FAIL because both production paths call xurl status functions.

- [ ] **Step 3: Gate passive xurl effects**

In `getLiveDataSourcesEffect`:

```typescript
const xurlStatus =
	resolveLiveReadMode() === "bird"
		? Effect.succeed(xurlDisabledDataSourceStatus())
		: getXurlStatusEffect();
const sources = yield* Effect.all(
	[getBirdclawStatusEffect(), getBirdStatusEffect(), xurlStatus],
	{ concurrency: "unbounded" },
);
```

In `getQueryEnvelopeEffect`, replace the unconditional transport effect:

```typescript
transport:
	resolveLiveReadMode() === "bird"
		? Effect.succeed(xurlDisabledTransportStatus())
		: getTransportStatusEffect(),
```

Add `delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE` to `queries.test.ts` cleanup.

- [ ] **Step 4: Run passive-status tests and verify GREEN**

Run: `pnpm test -- src/lib/data-sources.test.ts src/lib/queries.test.ts src/routes/api/status.test.tsx`

Expected: PASS; Bird mode performs no xurl status or OAuth lookup, while existing default/xurl tests still perform one probe.

- [ ] **Step 5: Commit passive probe changes when safe**

```bash
git add src/lib/data-sources.ts src/lib/data-sources.test.ts src/lib/query-status.ts src/lib/queries.test.ts
git commit -m "fix: skip passive xurl probes in bird mode"
```

### Task 5: Remove Implicit xurl from Analysis and xurl-only Commands

**Files:**
- Modify: `src/lib/profile-analysis.ts:70-90,1020-1325`
- Modify: `src/lib/profile-analysis.test.ts`
- Modify: `src/routes/api/profile-analysis.tsx:20-45`
- Modify: `src/routes/api/profile-analysis.test.ts`
- Modify: `src/lib/search-discussion.ts:761-783`
- Modify: `src/routes/api/search-discussion.tsx:41-59`
- Modify: `src/lib/route-search.ts:118-140`
- Modify: `src/cli/register-analysis.ts:152-164,382-420`
- Modify: `src/lib/authored-live.ts:30-40,822-835`
- Modify: `src/cli/register-sync.ts:129-167`
- Modify: `src/cli.test.ts`
- Modify: `src/lib/blocks.ts:110-144`
- Modify: `src/lib/blocks.test.ts`

- [ ] **Step 1: Write failing profile-analysis and block-sync tests**

In `profile-analysis.test.ts`, extend the hoisted mock object and add the Bird module mock:

```typescript
const mocks = vi.hoisted(() => ({
	listUserTweetsEffect: vi.fn(),
	lookupUsersByHandlesEffect: vi.fn(),
	searchRecentByConversationIdEffect: vi.fn(),
	getTransportStatusEffect: vi.fn(),
	lookupProfileViaBirdEffect: vi.fn(),
	listUserTweetsViaBirdEffect: vi.fn(),
	listThreadViaBirdEffect: vi.fn(),
}));

vi.mock("./bird", () => ({
	lookupProfileViaBirdEffect: (...args: unknown[]) =>
		mocks.lookupProfileViaBirdEffect(...args),
	listUserTweetsViaBirdEffect: (...args: unknown[]) =>
		mocks.listUserTweetsViaBirdEffect(...args),
	listThreadViaBirdEffect: (...args: unknown[]) =>
		mocks.listThreadViaBirdEffect(...args),
}));
```

Then add the Bird-only test:

```typescript
it("uses Bird analysis backfill without probing xurl in Bird mode", async () => {
	process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
	resetBirdclawPathsForTests();
	mocks.lookupProfileViaBirdEffect.mockReturnValue(
		Effect.succeed(profileUser),
	);
	mocks.listUserTweetsViaBirdEffect.mockReturnValue(
		Effect.succeed({
			data: [
				{
					id: "tweet_bird",
					author_id: "42",
					text: "Bird-only profile context.",
					created_at: "2026-05-20T10:00:00.000Z",
					conversation_id: "tweet_bird",
					public_metrics: { like_count: 1 },
				},
			],
			includes: { users: [profileUser], media: [] },
		}),
	);
	mocks.listThreadViaBirdEffect.mockReturnValue(
		Effect.succeed({ data: [], includes: {} }),
	);

	await streamProfileAnalysis({
		handle: "alice",
		mode: "bird",
		refresh: true,
		maxPages: 1,
		maxTweets: 10,
		maxConversations: 1,
		maxConversationPages: 1,
	});

	expect(mocks.getTransportStatusEffect).not.toHaveBeenCalled();
	expect(mocks.lookupProfileViaBirdEffect).toHaveBeenCalled();
	expect(mocks.listUserTweetsViaBirdEffect).toHaveBeenCalled();
});
```

Reset the three Bird mocks in `beforeEach`, and delete `BIRDCLAW_MENTIONS_DATA_SOURCE` during cleanup. In `blocks.test.ts`, call `setupTempHome()` and add:

```typescript
it("skips xurl block sync without probing when Bird actions are selected", async () => {
	setupTempHome();
	process.env.BIRDCLAW_ACTIONS_TRANSPORT = "bird";
	resetBirdclawPathsForTests();
	const { syncBlocks } = await import("./blocks");

	await expect(syncBlocks("acct_primary")).resolves.toMatchObject({
		ok: true,
		synced: false,
		transport: { output: "remote block sync skipped (xurl disabled by bird transport selection)" },
	});
	expect(mocks.getTransportStatus).not.toHaveBeenCalled();
});
```

Delete `BIRDCLAW_ACTIONS_TRANSPORT` in `blocks.test.ts` cleanup.

- [ ] **Step 2: Write failing Discuss and authored-default tests**

Update route-search coverage to expect Bird instead of xurl when no Discuss mode is present:

```typescript
expect(validateDiscussSearch({}).mode).toBe("bird");
```

In the API search-discussion test, mock `resolveLiveReadMode` to return `"bird"`, omit `mode` from the request, and assert `streamSearchDiscussionEffect` receives `mode: "bird"`. In `src/cli.test.ts`, make the live-read policy mock return `"bird"` and assert:

```typescript
expect(streamSearchDiscussionMock).toHaveBeenCalledWith(
	expect.objectContaining({ mode: "bird" }),
	expect.anything(),
);

await runCli(["node", "birdclaw", "sync", "authored"]);
expect(syncAuthoredTweetsMock).toHaveBeenCalledWith(
	expect.objectContaining({ mode: "bird" }),
);
```

The authored call is expected to reject through the existing `AuthoredSyncError` path without invoking xurl. Keep a control test that `sync authored --mode xurl` passes `mode: "xurl"`.

Add a direct adapter-boundary test to `authored-live.test.ts` beside the existing lazy-validation tests:

```typescript
it("rejects Bird authored sync without probing xurl", async () => {
	makeTempHome();
	const { syncAuthoredTweetsEffect } = await import("./authored-live");

	await expect(
		Effect.runPromise(
			syncAuthoredTweetsEffect({ mode: "bird", limit: 5 }),
		),
	).rejects.toThrow(
		"authored sync requires an explicit --mode xurl in Bird mode",
	);
	expect(mocks.getTransportStatus).not.toHaveBeenCalled();
	expect(mocks.lookupAuthenticatedUser).not.toHaveBeenCalled();
	expect(mocks.listUserTweets).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the analysis/command tests and verify RED**

Run: `pnpm test -- src/lib/profile-analysis.test.ts src/lib/blocks.test.ts src/lib/route-search.test.ts src/routes/api/search-discussion.test.ts src/cli.test.ts src/lib/authored-live.test.ts`

Expected: FAIL because profile analysis and block sync probe xurl, Discuss defaults to xurl/auto instead of configured Bird, and authored has a Commander-supplied xurl default.

- [ ] **Step 4: Gate profile analysis and remote block sync before xurl status**

In profile analysis, resolve the live mode before the status lookup:

```typescript
const liveMode = resolveLiveReadMode(options.mode);
const transport =
	liveMode === "bird"
		? xurlDisabledTransportStatus()
		: yield* getTransportStatusEffect();
```

Add `mode?: LiveReadMode` to `ProfileAnalysisOptions`. The existing `transport.availableTransport !== "xurl"` branches already call Bird for profile lookup, user tweets, and conversations; leave those branches intact. In `syncBlocksEffect`, add before `getTransportStatusEffect`:

```typescript
if (resolveActionsTransport() === "bird") {
	return {
		ok: true,
		accountId: resolvedAccountId,
		synced: false,
		syncedCount: 0,
		transport: {
			ok: true,
			output:
				"remote block sync skipped (xurl disabled by bird transport selection)",
		},
	};
}
```

- [ ] **Step 5: Remove Discuss and authored implicit defaults**

Use the policy only when callers omit a mode:

```typescript
// search-discussion.ts
const mode = options.mode ?? resolveLiveReadMode();

// API parseMode
if (value === "auto" || value === "bird" || value === "xurl" || value === "local") {
	return value;
}
return resolveLiveReadMode();

// CLI parseTweetSearchMode
if (value === undefined) return resolveLiveReadMode();
```

Change `validateDiscussSearch`'s browser default from `"xurl"` to `"bird"`; the visible mode selector still lets the user explicitly choose auto or xurl. Remove the Commander defaults from `discuss --mode` and `sync authored --mode`. Pass `resolveLiveReadMode(options.mode)` to authored sync, so configured Bird reaches the existing `authored sync only supports --mode xurl` failure before any xurl command, while `--mode xurl` remains functional.

Widen `AuthoredSyncMode` to `LiveReadMode`, remove the `mode = "xurl"` function default, and resolve inside `syncAuthoredTweetsEffect` before the existing support check:

```typescript
export type AuthoredSyncMode = LiveReadMode;

const resolvedMode = resolveLiveReadMode(mode);
if (resolvedMode !== "xurl") {
	return yield* Effect.fail(
		new Error("authored sync requires an explicit --mode xurl in Bird mode"),
	);
}
```

Add an optional `mode` query parameter to the profile-analysis API parser and an optional `--mode <mode>` to the profile-analysis CLI. Both pass only validated `bird`, `auto`, or `xurl` values; an omitted value is resolved inside `profile-analysis.ts`.

- [ ] **Step 6: Run the analysis/command tests and verify GREEN**

Run: `pnpm test -- src/lib/profile-analysis.test.ts src/lib/blocks.test.ts src/lib/route-search.test.ts src/routes/api/search-discussion.test.ts src/cli.test.ts src/lib/authored-live.test.ts`

Expected: PASS; Bird analysis uses only Bird mocks, Bird block sync never probes xurl, default Discuss uses Bird, and authored requires an explicit/configured xurl selection.

- [ ] **Step 7: Commit the analysis/command files when the worktree still matches the baseline**

```bash
git add src/lib/profile-analysis.ts src/lib/profile-analysis.test.ts src/routes/api/profile-analysis.tsx src/routes/api/profile-analysis.test.ts src/lib/search-discussion.ts src/routes/api/search-discussion.tsx src/routes/api/search-discussion.test.ts src/lib/route-search.ts src/lib/route-search.test.ts src/cli/register-analysis.ts src/cli/register-sync.ts src/cli.test.ts src/lib/authored-live.ts src/lib/authored-live.test.ts src/lib/blocks.ts src/lib/blocks.test.ts
git commit -m "fix: remove implicit xurl analysis defaults"
```

### Task 6: Keep Scheduled Mention Threads on Bird

**Files:**
- Modify: `src/lib/account-sync-job.ts:1-4,180-332`
- Modify: `src/lib/account-sync-job.test.ts:1-68,413-452`

- [ ] **Step 1: Write failing explicit and configured Bird job tests**

Replace the existing mention-thread xurl-only expectation with an explicit Bird case:

```typescript
it("keeps mention-thread jobs on Bird when Bird is selected", async () => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
	const logPath = path.join(tempDir, "audit.jsonl");
	const lockPath = path.join(tempDir, "sync.lock");
	syncMentionThreadsMock.mockResolvedValue({
		source: "bird",
		mergedTweets: 4,
	});

	const result = await runAccountSyncJob({
		steps: ["mention-threads"],
		mode: "bird",
		logPath,
		lockPath,
		db: {
			prepare: () => ({ get: () => ({ id: "acct_primary" }) }),
		} as never,
	});

	expect(syncMentionThreadsMock).toHaveBeenCalledWith(
		expect.objectContaining({ mode: "bird", limit: 30 }),
	);
	expect(result.steps).toEqual([
		expect.objectContaining({ source: "bird", count: 4 }),
	]);
});
```

Add the policy mock beside the existing hoisted mocks:

```typescript
const resolveLiveReadModeMock = vi.hoisted(() => vi.fn());

vi.mock("./live-transport-policy", () => ({
	resolveLiveReadMode: (...args: unknown[]) =>
		resolveLiveReadModeMock(...args),
}));
```

Reset it in `beforeEach` with the existing mocks:

```typescript
resolveLiveReadModeMock.mockReset();
resolveLiveReadModeMock.mockImplementation(
	(requested?: string, legacyDefault = "xurl") =>
		requested ?? legacyDefault,
);
```

Add the configured-default case:

```typescript
it("uses configured Bird mode for omitted mention-thread job mode", async () => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-account-job-"));
	const logPath = path.join(tempDir, "audit.jsonl");
	const lockPath = path.join(tempDir, "sync.lock");
	resolveLiveReadModeMock.mockReturnValue("bird");
	syncMentionThreadsMock.mockResolvedValue({
		source: "bird",
		mergedTweets: 2,
	});

	await runAccountSyncJob({
		steps: ["mention-threads"],
		logPath,
		lockPath,
		db: {
			prepare: () => ({ get: () => ({ id: "acct_primary" }) }),
		} as never,
	});

	expect(resolveLiveReadModeMock).toHaveBeenCalledWith(undefined, "auto");
	expect(syncMentionThreadsMock).toHaveBeenCalledWith(
		expect.objectContaining({ mode: "bird" }),
	);
});
```

- [ ] **Step 2: Run the account job test and verify RED**

Run: `pnpm test -- src/lib/account-sync-job.test.ts`

Expected: FAIL because mention threads receive `mode: "xurl"` and omitted job mode is hard-coded to `auto` before policy resolution.

- [ ] **Step 3: Resolve the job mode once and preserve Bird for threads**

Import `resolveLiveReadMode`. Remove the `mode = "auto"` destructuring default, then resolve the optional mode before building audit options while passing the job's old `auto` default explicitly:

```typescript
const resolvedMode = resolveLiveReadMode(mode, "auto");
const options = {
	account,
	steps,
	mode: resolvedMode,
	limit,
	maxPages,
	refresh,
	cacheTtlMs,
};
```

Use `options.mode` for every `runStep` invocation and in the persisted audit entry.

In the mention-thread branch:

```typescript
const threadMode = mode === "bird" ? "bird" : "xurl";
const result = await syncMentionThreads({
	account,
	mode: threadMode,
	limit: Math.min(30, limit),
	delayMs: 1500,
	timeoutMs: 15000,
});
```

`auto` remains allowed to choose xurl, and explicit xurl continues to behave as before.

- [ ] **Step 4: Run the account job test and verify GREEN**

Run: `pnpm test -- src/lib/account-sync-job.test.ts`

Expected: PASS; explicit/configured Bird passes `mode: "bird"`, while the existing auto/xurl control still passes `mode: "xurl"`.

- [ ] **Step 5: Commit job changes when safe**

```bash
git add src/lib/account-sync-job.ts src/lib/account-sync-job.test.ts
git commit -m "fix: keep scheduled thread sync on bird"
```

### Task 7: Full Verification and Static Audit

**Files:**
- Review all production files reported by the audit commands.
- Modify only automatic orchestration call sites that still violate the invariant.

- [ ] **Step 1: Run the focused regression suite**

Run:

```bash
pnpm test -- src/lib/live-transport-policy.test.ts src/lib/period-digest-live.test.ts src/routes/api/period-digest.test.ts src/routes/api/period-digest-metadata.test.ts src/cli.test.ts src/lib/profile-resolver.test.ts src/lib/profile-hydration.test.ts src/lib/profile-hydration-client.test.ts src/lib/data-sources.test.ts src/lib/queries.test.ts src/routes/api/status.test.tsx src/lib/profile-analysis.test.ts src/lib/blocks.test.ts src/lib/route-search.test.ts src/routes/api/search-discussion.test.ts src/lib/authored-live.test.ts src/lib/account-sync-job.test.ts
```

Expected: PASS with zero failing tests.

- [ ] **Step 2: Audit production hard-coded xurl modes and probes**

Run:

```bash
rg -n --glob 'src/**/*.{ts,tsx}' --glob '!src/**/*.test.*' '(mode|transport|liveSyncMode)\s*:\s*["'\'']xurl["'\'']|\?\?\s*["'\'']xurl["'\'']|getTransportStatusEffect\(' src
rg -n --glob 'src/**/*.{ts,tsx}' --glob '!src/**/*.test.*' 'liveTransportGateway\.xurl|from ["'\''](?:\./|#/lib/)xurl["'\'']' src
```

Expected: every match is one of the allowed categories from the design: explicit xurl branch, auto fallback, xurl adapter, xurl-only feature, stored source label, or compatibility type. Any automatic Bird-reachable match gets a failing test and the same red-green fix cycle before continuing.

- [ ] **Step 3: Run formatting, lint, type checks, and the full suite**

Run:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

Expected: every command exits 0 with no warnings promoted to errors and no failing tests.

- [ ] **Step 4: Review the final diff against the design invariant**

Run:

```bash
git diff --check
git diff -- src/lib/live-transport-policy.ts src/lib/period-digest.ts src/lib/period-digest-request.ts src/cli/register-analysis.ts src/lib/profile-resolver.ts src/lib/profile-hydration.ts src/lib/data-sources.ts src/lib/query-status.ts src/lib/account-sync-job.ts
```

Expected: no whitespace errors; every Bird-mode branch either calls Bird, returns local/disabled status, or surfaces the existing partial/error result without xurl fallback.

- [ ] **Step 5: Record the final worktree state without staging unrelated changes**

```bash
git status --short
```

Expected: only files intentionally changed by this plan are listed. If new user changes appeared during execution, preserve them separately. If Step 2 found and fixed another automatic Bird-reachable call site, add its exact test and production paths to the nearest task's commit; do not create an empty audit commit.
