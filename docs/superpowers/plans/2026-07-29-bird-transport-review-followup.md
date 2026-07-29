# Bird Transport Review Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every validated PR #40 transport-policy review issue without weakening the invariant that resolved Bird operations never probe, invoke, or fall back to xurl.

**Architecture:** Add `live.dataSource` as the accurately named global live-read preference while retaining the mentions setting as a compatibility alias. Move historical capability defaults into named policy resolvers, then make CLI, web, block sync, profile inspection, and low-level adapters consume those resolvers. Keep xurl-only writes disabled under Bird, but make explicit xurl read overrides consistent and document the resulting public contract.

**Tech Stack:** TypeScript 7, Effect, Commander, TanStack Router, Zod, Vitest, pnpm.

---

## File Map

- `src/lib/config.ts`: public config keys, compatibility aliases, and action-transport errors.
- `src/lib/live-transport-policy.ts`: named live-read policy resolvers and disabled status builders.
- `src/cli/register-sync.ts`: sync and mention-thread mode resolution.
- `src/lib/route-search.ts`, `src/routes/discuss.tsx`: configured Discuss mode state and request serialization.
- `src/lib/blocks.ts`, `src/cli-moderation.ts`: read-policy ownership for remote block sync.
- `src/lib/profile-replies.ts`, `src/cli/register-mentions.ts`: explicit profile-reply mode override.
- `src/cli/register-dms.ts`, `src/cli/register-search.ts`: positive and negative xurl fallback switches.
- `src/lib/types.ts`, `src/lib/api-contracts.ts`: unknown installation state for policy-disabled xurl.
- `src/lib/x-lists.ts`, `src/lib/tweet-search-live.ts`: policy-aware low-level omitted modes.
- `README.md`, `docs/configuration.md`, `docs/auth.md`, `docs/cli.md`, `docs/dms.md`, `docs/search.md`, `CHANGELOG.md`: public transport contract.

### Task 1: Centralize Global Live-read Configuration and Capability Defaults

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/lib/config.test.ts`
- Modify: `src/lib/live-transport-policy.ts`
- Modify: `src/lib/live-transport-policy.test.ts`
- Modify: `src/cli/register-sync.ts`
- Modify: `src/cli/register-jobs.ts`
- Modify: `src/lib/account-sync-job.ts`
- Modify: `src/lib/bookmark-sync-job.ts`
- Modify: `src/lib/profile-replies.ts`
- Modify: `src/lib/tweet-lookup.ts`
- Modify: `src/lib/timeline-collections-live.ts`
- Modify: `src/lib/web-sync.ts`
- Modify: `src/cli.test.ts`
- Modify the focused tests paired with the listed production callers

- [ ] **Step 1: Write failing config precedence tests**

Add tests that write conflicting config/env values and assert this precedence:

```typescript
writeBirdclawConfig({
	live: { dataSource: "bird" },
	mentions: { dataSource: "xurl" },
});
expect(resolveMentionsDataSource()).toBe("bird");

process.env.BIRDCLAW_LIVE_DATA_SOURCE = "auto";
expect(resolveMentionsDataSource()).toBe("auto");

delete process.env.BIRDCLAW_LIVE_DATA_SOURCE;
writeBirdclawConfig({ mentions: { dataSource: "xurl" } });
expect(resolveMentionsDataSource()).toBe("xurl");
```

Extend the environment snapshot/reset helpers to include
`BIRDCLAW_LIVE_DATA_SOURCE`.

- [ ] **Step 2: Run the config tests and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/config.test.ts src/lib/live-transport-policy.test.ts
```

Expected: FAIL because `BirdclawConfig.live` and the new environment variable do
not exist.

- [ ] **Step 3: Add the compatible global config key**

Implement these types and resolution order in `src/lib/config.ts`:

```typescript
export type LiveDataSource = "auto" | "bird" | "xurl";
export type MentionsDataSource = "birdclaw" | LiveDataSource;

live?: { dataSource?: LiveDataSource };

function liveDataSource(value: unknown): LiveDataSource | undefined {
	return value === "auto" || value === "bird" || value === "xurl"
		? value
		: undefined;
}
```

`resolveMentionsDataSource(requestedMode)` must resolve an explicit valid value,
then `BIRDCLAW_LIVE_DATA_SOURCE`, `live.dataSource`, the legacy environment
variable, the legacy config key, and finally `birdclaw`.

- [ ] **Step 4: Write failing named-policy tests**

Add tests for the three public capabilities:

```typescript
expect(resolveLiveReadMode()).toBe("xurl");
expect(resolveLiveSyncMode()).toBe("auto");
expect(resolveMentionThreadReadMode()).toBe("bird");
expect(() => resolveMentionThreadReadMode("auto")).toThrow(
	"Mention-thread sync supports only bird or xurl",
);
expect(() => resolveLiveReadMode("invalid")).toThrow(
	"Invalid live-read mode; expected auto, bird, or xurl",
);
```

Use these exact transport-neutral messages consistently in implementation and
assertions; shared policy functions must not emit CLI-prefixed errors.

- [ ] **Step 5: Run the policy test and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/live-transport-policy.test.ts
```

Expected: FAIL because the named sync and mention-thread resolvers do not exist.

- [ ] **Step 6: Replace the public fallback parameter with named resolvers**

Implement the policy internally as:

```typescript
type LiveReadCapability = "xurl-first" | "sync" | "mention-threads";

const capabilityDefaults: Record<LiveReadCapability, LiveReadMode> = {
	"xurl-first": "xurl",
	sync: "auto",
	"mention-threads": "bird",
};

function resolveForCapability(
	requestedMode: string | undefined,
	capability: LiveReadCapability,
): LiveReadMode {
	if (requestedMode !== undefined) {
		if (
			requestedMode === "auto" ||
			requestedMode === "bird" ||
			requestedMode === "xurl"
		) return requestedMode;
		throw new Error("Invalid live-read mode; expected auto, bird, or xurl");
	}
	const configured = resolveMentionsDataSource();
	return configured === "birdclaw"
		? capabilityDefaults[capability]
		: configured;
}

export const resolveLiveReadMode = (mode?: string) =>
	resolveForCapability(mode, "xurl-first");

export const resolveLiveSyncMode = (mode?: string) =>
	resolveForCapability(mode, "sync");
```

`resolveMentionThreadReadMode` must use the `mention-threads` capability and
reject the unsupported resolved `auto` value before returning `bird | xurl`.
Add a short comment explaining that legacy `birdclaw` is treated as an omitted
global preference outside mention export to preserve pre-policy behavior.

- [ ] **Step 7: Update every fallback-literal caller**

Replace every `resolveLiveReadMode(value, "auto")` with
`resolveLiveSyncMode(value)`. Replace the mention-thread helper in
`src/cli/register-sync.ts` with `resolveMentionThreadReadMode`. Keep implicit
`resolveLiveReadMode()` callers on the xurl-first capability. The static command

```bash
rg -n 'resolveLiveReadMode\\([^)]*,\\s*"(auto|bird|xurl)"' src
```

must return no production matches.

Update module mocks in `src/cli.test.ts` to expose
`resolveLiveSyncModeMock` and `resolveMentionThreadReadModeMock`; default both to
Bird in the existing Bird-oriented CLI fixture, and reset both in `beforeEach`.

Update `resolveActionsTransport` to throw
`Invalid action transport; expected auto, bird, or xurl`, then update its tests.

- [ ] **Step 8: Run the focused policy and caller tests**

Run:

```bash
pnpm exec vitest run src/lib/config.test.ts src/lib/live-transport-policy.test.ts src/cli.test.ts src/lib/account-sync-job.test.ts src/lib/bookmark-sync-job.test.ts src/lib/tweet-lookup.test.ts src/lib/timeline-collections-live.test.ts src/lib/web-sync.test.ts
```

Expected: all selected files pass.

- [ ] **Step 9: Commit the policy refactor**

```bash
git add src/lib/config.ts src/lib/config.test.ts src/lib/live-transport-policy.ts src/lib/live-transport-policy.test.ts src/cli/register-sync.ts src/cli/register-jobs.ts src/lib/account-sync-job.ts src/lib/bookmark-sync-job.ts src/lib/profile-replies.ts src/lib/tweet-lookup.ts src/lib/timeline-collections-live.ts src/lib/web-sync.ts src/cli.test.ts src/lib/account-sync-job.test.ts src/lib/bookmark-sync-job.test.ts src/lib/tweet-lookup.test.ts src/lib/timeline-collections-live.test.ts src/lib/web-sync.test.ts
git commit -m "fix: centralize live read capability defaults"
```

### Task 2: Fix Omitted Modes in Mention Threads, Discuss, and Block Sync

**Files:**
- Modify: `src/cli/register-sync.ts`
- Modify: `src/cli.test.ts`
- Modify: `src/lib/route-search.ts`
- Modify: `src/lib/route-search.test.ts`
- Modify: `src/routes/discuss.tsx`
- Modify: `src/routes/discuss.test.tsx`
- Modify: `src/routes/api/search-discussion.test.ts`
- Modify: `src/lib/blocks.ts`
- Modify: `src/lib/blocks.test.ts`
- Modify: `src/cli-moderation.ts`

- [ ] **Step 1: Write the mention-thread configuration regression test**

Use the real Commander wrapper in `src/cli.test.ts`:

```typescript
resolveMentionThreadReadModeMock.mockReturnValue("xurl");
await runCli(["node", "birdclaw", "sync", "mention-threads"]);
expect(syncMentionThreadsMock).toHaveBeenCalledWith(
	expect.objectContaining({ mode: "xurl" }),
);
```

Also assert the mode option has value source `undefined` when omitted rather than
Commander `default`.

- [ ] **Step 2: Run the CLI test and verify RED**

Run:

```bash
pnpm exec vitest run src/cli.test.ts -t "mention-threads"
```

Expected: FAIL because Commander supplies `bird` before policy resolution.

- [ ] **Step 3: Remove the mention-thread Commander default**

Change the option to:

```typescript
.option("--mode <mode>", "bird or xurl")
```

Resolve it with `resolveMentionThreadReadMode(options.mode)` and report that
resolved value in both success and error payloads.

- [ ] **Step 4: Write Discuss configured-mode tests**

In `src/lib/route-search.test.ts`, assert `validateDiscussSearch({}).mode === ""`
and explicit `bird`, `auto`, `xurl`, and `local` values are retained. In
`src/routes/discuss.test.tsx`, submit the default form and assert the fetch URL
has no `mode` query parameter; after selecting xurl, assert `mode=xurl` is sent.

- [ ] **Step 5: Run Discuss tests and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/route-search.test.ts src/routes/discuss.test.tsx src/routes/api/search-discussion.test.ts
```

Expected: FAIL because the route defaults to Bird and always serializes mode.

- [ ] **Step 6: Represent configured mode explicitly in the UI**

Add:

```typescript
export type DiscussRouteMode = TweetSearchMode | "";
```

Use it in `DiscussRouteSearch`, default validation to `""`, add a
`{ value: "", label: "Configured" }` select option, and serialize mode only when
non-empty:

```typescript
if (options.mode) url.searchParams.set("mode", options.mode);
```

The API's existing missing-mode branch remains responsible for calling the
shared policy.

- [ ] **Step 7: Write block-sync policy ownership tests**

Add library tests for these conflicting configurations:

```typescript
process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
process.env.BIRDCLAW_ACTIONS_TRANSPORT = "auto";
const skipped = await syncBlocks("acct_primary");
expect(skipped).toMatchObject({ ok: true, synced: false });
expect(mocks.getTransportStatus).not.toHaveBeenCalled();

process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "xurl";
process.env.BIRDCLAW_ACTIONS_TRANSPORT = "bird";
await syncBlocks("acct_primary");
expect(mocks.getTransportStatus).toHaveBeenCalled();
```

Add a CLI assertion that `blocks sync --mode xurl` forwards the explicit mode.

- [ ] **Step 8: Run block tests and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/blocks.test.ts src/cli.test.ts -t "block sync"
```

Expected: FAIL because block sync reads `actions.transport` and exposes no mode.

- [ ] **Step 9: Move block sync to live-read policy**

Define:

```typescript
interface SyncBlocksOptions { mode?: string }
```

Resolve `resolveLiveSyncMode(options.mode)` before opening the database. Use that
resolved value for the Bird silent-skip guard. Add `--mode <mode>` to the sync
subcommand and pass `{ mode: options.mode }`; existing API callers can omit the
new optional object.

- [ ] **Step 10: Run the full Task 2 focused suite**

```bash
pnpm exec vitest run src/cli.test.ts src/lib/route-search.test.ts src/routes/discuss.test.tsx src/routes/api/search-discussion.test.ts src/lib/blocks.test.ts
```

Expected: all selected files pass.

- [ ] **Step 11: Commit the behavior fixes**

```bash
git add src/cli/register-sync.ts src/cli.test.ts src/lib/route-search.ts src/lib/route-search.test.ts src/routes/discuss.tsx src/routes/discuss.test.tsx src/routes/api/search-discussion.test.ts src/lib/blocks.ts src/lib/blocks.test.ts src/cli-moderation.ts
git commit -m "fix: honor configured read modes at entrypoints"
```

### Task 3: Add Consistent Explicit xurl Overrides

**Files:**
- Modify: `src/lib/profile-replies.ts`
- Modify: `src/lib/profile-replies.test.ts`
- Modify: `src/cli/register-mentions.ts`
- Modify: `src/cli/register-dms.ts`
- Modify: `src/cli/register-search.ts`
- Modify: `src/cli.test.ts`
- Modify: `src/lib/query-actions.ts`
- Modify: `src/lib/queries.test.ts`

- [ ] **Step 1: Write profile-reply override tests**

Under configured Bird, assert the omitted call fails before xurl while an
explicit xurl call succeeds:

```typescript
await expect(inspectProfileReplies("@jpctan")).rejects.toThrow(
	"Profile reply inspection requires xurl",
);
await inspectProfileReplies("@jpctan", { mode: "xurl", limit: 1 });
expect(mocks.listUserTweets).toHaveBeenCalledTimes(1);
```

Add a CLI test that `profiles replies @jpctan --mode xurl` forwards
`{ mode: "xurl" }`.

- [ ] **Step 2: Run profile-reply tests and verify RED**

```bash
pnpm exec vitest run src/lib/profile-replies.test.ts src/cli.test.ts -t "profile replies|recent profile replies"
```

Expected: FAIL because the API has no mode option.

- [ ] **Step 3: Add the explicit profile-reply mode**

Create and reuse this option type:

```typescript
export interface InspectProfileRepliesOptions {
	account?: string;
	limit?: number;
	mode?: string;
}
```

Resolve `resolveLiveSyncMode(options.mode)` before account/profile lookup. Bird
must fail with `Profile reply inspection requires xurl; select xurl explicitly`
and xurl/auto keep the existing xurl implementation. Add `--mode <mode>` to the
CLI command.

- [ ] **Step 4: Write positive and negative fallback CLI tests**

For `dms list`, `search dms`, and `whois`, assert:

```typescript
await runCli([...baseArgs, "--xurl-fallback"]);
expect(target).toHaveBeenCalledWith(
	expect.anything(),
	expect.objectContaining({ xurlFallback: true }),
);

await runCli([...baseArgs, "--no-xurl-fallback"]);
expect(target).toHaveBeenCalledWith(
	expect.anything(),
	expect.objectContaining({ xurlFallback: false }),
);
```

Keep an omitted-control assertion that the forwarded value is `undefined`.

- [ ] **Step 5: Run CLI fallback tests and verify RED**

```bash
pnpm exec vitest run src/cli.test.ts -t "xurl fallback"
```

Expected: FAIL because Commander only registers the negative spelling.

- [ ] **Step 6: Register dual-form fallback switches**

Replace each negative-only option in `register-dms.ts` and `register-search.ts`
with:

```typescript
.option(
	"--[no-]xurl-fallback",
	"Enable or disable xurl fallback after Bird profile lookup",
)
```

Keep `command.getOptionValueSource("xurlFallback") === "cli"` so omission still
delegates to configured policy.

- [ ] **Step 7: Clarify the intentional Bird compose rejection**

Change the preflight error to:

```typescript
throw new Error(
	"Compose writes require xurl; set actions.transport to auto or xurl",
);
```

Update the existing post/reply/DM tests to assert the error occurs before draft
staging, authentication, xurl action, or database mutation.

- [ ] **Step 8: Run the Task 3 focused suite**

```bash
pnpm exec vitest run src/lib/profile-replies.test.ts src/cli.test.ts src/lib/queries.test.ts
```

Expected: all selected files pass.

- [ ] **Step 9: Commit explicit override behavior**

```bash
git add src/lib/profile-replies.ts src/lib/profile-replies.test.ts src/cli/register-mentions.ts src/cli/register-dms.ts src/cli/register-search.ts src/cli.test.ts src/lib/query-actions.ts src/lib/queries.test.ts
git commit -m "fix: expose explicit xurl read overrides"
```

### Task 4: Correct Disabled Status, Leaf Defaults, and Documentation

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api-contracts.ts`
- Modify: `src/lib/live-transport-policy.ts`
- Modify: `src/lib/live-transport-policy.test.ts`
- Modify: `src/lib/queries.test.ts`
- Modify: `src/lib/x-lists.ts`
- Modify: `src/lib/x-lists.test.ts`
- Modify: `src/lib/tweet-search-live.ts`
- Modify: `src/lib/tweet-search-live.test.ts`
- Modify: `src/lib/period-digest.ts`
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/auth.md`
- Modify: `docs/cli.md`
- Modify: `docs/dms.md`
- Modify: `docs/search.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the unknown-installation status test**

Assert the policy-disabled transport does not claim installation state:

```typescript
expect(xurlDisabledTransportStatus()).toEqual({
	availableTransport: "local",
	statusText: "xurl disabled by bird transport selection",
});
```

Parse the result through `queryEnvelopeSchema` and assert `installed` remains
`undefined`, rather than being defaulted to false.

- [ ] **Step 2: Run status tests and verify RED**

```bash
pnpm exec vitest run src/lib/live-transport-policy.test.ts src/lib/queries.test.ts
```

Expected: FAIL because `TransportStatus.installed` is required and the schema
defaults it to false.

- [ ] **Step 3: Make installation state optional**

Change the interface and schema to:

```typescript
export interface TransportStatus {
	installed?: boolean;
	availableTransport: "xurl" | "local";
	statusText: string;
	rawStatus?: string;
}

const transportStatusSchema: z.ZodType<TransportStatus> = z.object({
	installed: z.boolean().optional(),
	availableTransport: z.enum(["xurl", "local"]).default("local"),
	statusText: z.string(),
	rawStatus: z.string().optional(),
});
```

Omit `installed` from `xurlDisabledTransportStatus`; real xurl status probes keep
returning a boolean.

- [ ] **Step 4: Write low-level omitted-mode tests**

Configure Bird, call `syncXListsEffect({})` and `syncTweetSearchEffect({ query:
"codex" })`, and assert no xurl adapter is invoked. Add explicit `auto` controls
that retain existing fallback behavior.

- [ ] **Step 5: Run leaf tests and verify RED**

```bash
pnpm exec vitest run src/lib/x-lists.test.ts src/lib/tweet-search-live.test.ts
```

Expected: FAIL because both leaves default directly to Auto.

- [ ] **Step 6: Resolve omitted leaf modes through policy**

In `x-lists.ts`, return `resolveLiveSyncMode()` when `normalizedMode` receives
undefined. In `tweet-search-live.ts`, remove `mode = "auto"` from destructuring
and set `const resolvedMode = mode ?? resolveLiveSyncMode()` before database or
transport work; use `resolvedMode` for all branches and cache identity.

- [ ] **Step 7: Restore the For You transport rationale**

Add this comment immediately above period-digest timeline mode selection:

```typescript
// xurl rejects following:false, so For You must use Bird (or Auto only when
// historical behavior requires the adapter to select Bird); resolved Bird may
// never be replaced with xurl here.
```

- [ ] **Step 8: Update the public contract**

Document all of the following with exact command/config examples:

```json
{
	"live": { "dataSource": "bird" },
	"actions": { "transport": "auto" },
	"mentions": { "birdCommand": "/path/to/bird" }
}
```

- `live.dataSource` controls live reads across sync, digest, Discuss, profiles,
  lists, graph, lookup, and enrichment.
- the old mentions source key/environment variable are compatibility aliases;
- `actions.transport` controls all writes; compose is xurl-only and rejects Bird;
- `profiles replies --mode xurl` and `--[no-]xurl-fallback` are explicit controls;
- precedence includes `BIRDCLAW_LIVE_DATA_SOURCE`;
- CHANGELOG `0.11.1 - Unreleased` records the behavior and compatibility alias.

- [ ] **Step 9: Run Task 4 tests and documentation checks**

```bash
pnpm exec vitest run src/lib/live-transport-policy.test.ts src/lib/queries.test.ts src/lib/x-lists.test.ts src/lib/tweet-search-live.test.ts
pnpm run format:check
```

Expected: all tests and formatting checks pass.

- [ ] **Step 10: Commit status and documentation changes**

```bash
git add src/lib/types.ts src/lib/api-contracts.ts src/lib/live-transport-policy.ts src/lib/live-transport-policy.test.ts src/lib/queries.test.ts src/lib/x-lists.ts src/lib/x-lists.test.ts src/lib/tweet-search-live.ts src/lib/tweet-search-live.test.ts src/lib/period-digest.ts README.md docs/configuration.md docs/auth.md docs/cli.md docs/dms.md docs/search.md CHANGELOG.md
git commit -m "docs: define global live transport behavior"
```

### Task 5: Full Verification, Review Response, and PR Update

**Files:**
- Inspect: all production files containing `xurl`
- Update: PR #40 branch and review discussion

- [ ] **Step 1: Run the complete focused regression set**

```bash
pnpm exec vitest run src/lib/config.test.ts src/lib/live-transport-policy.test.ts src/cli.test.ts src/lib/route-search.test.ts src/routes/discuss.test.tsx src/routes/api/search-discussion.test.ts src/lib/blocks.test.ts src/lib/profile-replies.test.ts src/lib/queries.test.ts src/lib/x-lists.test.ts src/lib/tweet-search-live.test.ts src/lib/account-sync-job.test.ts src/lib/bookmark-sync-job.test.ts src/lib/tweet-lookup.test.ts src/lib/timeline-collections-live.test.ts src/lib/web-sync.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run static transport audits**

```bash
rg -n 'resolveLiveReadMode\\([^)]*,\\s*"(auto|bird|xurl)"' src
rg -n --glob '!**/*.test.*' '(command:\\s*"xurl"|spawn.*xurl|execFile.*xurl)' src
rg -n --glob '!**/*.test.*' 'BIRDCLAW_MENTIONS_DATA_SOURCE|mentions\\.dataSource' src README.md docs CHANGELOG.md
```

Expected: no fallback-literal resolver calls; xurl subprocess literals remain
confined to `src/lib/xurl.ts`; every legacy config reference is compatibility
code or documentation.

- [ ] **Step 3: Run all quality gates**

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
git diff --check origin/feature/prompt-templates-playground...HEAD
```

Expected: every command exits 0.

- [ ] **Step 4: Run the full test suite outside the loopback-restricted sandbox**

```bash
pnpm test
```

Expected: every Vitest file and test passes, including production-server
loopback tests.

- [ ] **Step 5: Request independent full-range review**

Review `d10ea41..HEAD` plus the original `ca12f7d..d10ea41` invariant. Require
explicit findings for config compatibility, named defaults, mention threads,
Discuss, block sync, explicit xurl overrides, status schemas, and Bird zero-xurl.
Do not treat the intended Bird block-sync silent skip as an error.

- [ ] **Step 6: Push and summarize the review response**

```bash
git push origin codex/bird-zero-xurl
```

Post a PR comment mapping each numbered review item to its implementation,
tests, or reasoned non-change. Include the final full-suite counts and note the
Node engine warning separately if it remains.
