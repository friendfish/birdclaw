# Issue #53 Empty Digest Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent empty model output from becoming a successful period digest while preserving per-source retries, previous latest-success content, and durable non-sensitive diagnostics.

**Architecture:** Add transport-level stream diagnostics and blank-output rejection, then enforce a shared period-digest displayability contract before every cache and publication boundary. Carry diagnostics through generation into the orchestrator audit, recover invalid stable current rows from valid legacy caches, and keep API/UI cache status consistent with renderable Markdown.

**Tech Stack:** TypeScript 7, Effect, Vitest, TanStack Start/React, native SQLite sync cache.

---

## File Map

- `src/lib/openai-response-runtime.ts`: collect stream diagnostics, normalize provider terminal events, and reject blank visible output.
- `src/lib/openai-response-runtime.test.ts`: transport regressions for empty, whitespace, reasoning-only, and length-truncated streams.
- `src/lib/analysis-runtime.ts`: propagate stream diagnostics and reject whitespace-only non-stream output.
- `src/lib/analysis-runtime.test.ts`: hybrid stream propagation and non-stream whitespace regression.
- `src/lib/period-digest-integrity.ts`: focused shared predicate and assertion for displayable digest results.
- `src/lib/period-digest-integrity.test.ts`: contract tests for valid fallback and placeholder-only results.
- `src/lib/period-digest.ts`: validate before generation-cache writes and carry diagnostics in results/caches.
- `src/lib/period-digest.test.ts`: prove invalid hybrid output never reaches digest caches.
- `src/lib/period-digest-current-store.ts`: validate current publication/read/migration and recover invalid stable rows.
- `src/lib/period-digest-current-store.test.ts`: store rejection, preservation, and recovery regressions.
- `src/lib/period-digest-orchestrator.ts`: validate inside retries and persist source diagnostics in run audit state.
- `src/lib/period-digest-orchestrator.test.ts`: retry exhaustion, source isolation, old-current preservation, and diagnostics tests.
- `src/routes/api/period-digest-metadata.tsx`: refuse cached metadata for non-displayable current values.
- `src/routes/api/period-digest-metadata.test.ts`: malformed mocked-current regression.
- `src/routes/today.tsx`: show cached/ready state only with non-empty Markdown.
- `src/routes/today.test.tsx`: cached/first-token contradiction regression.

### Task 1: Reject Blank Streams and Capture Diagnostics

**Files:**
- Modify: `src/lib/openai-response-runtime.test.ts:71-251`
- Modify: `src/lib/openai-response-runtime.ts:12-272`

- [ ] **Step 1: Write failing transport tests**

Add a helper and tests that inspect both the thrown error and its structured
diagnostics:

```ts
function responseStream(...events: Array<Record<string, unknown> | "[DONE]">) {
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const event of events) {
					const data = event === "[DONE]" ? event : JSON.stringify(event);
					controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
				}
				controller.close();
			},
		}),
	);
}

it.each([
	["empty", responseStream("[DONE]"), 0],
	[
		"whitespace-only",
		responseStream(
			{ type: "response.output_text.delta", delta: "  \n\t" },
			"[DONE]",
		),
		4,
	],
])("rejects %s visible output", async (_label, response, visibleTextLength) => {
	const error = await Effect.runPromise(
		Effect.flip(readOpenAIResponseStreamEffect(response)),
	);
	expect(error).toBeInstanceOf(OpenAIStreamError);
	expect((error as OpenAIStreamError).diagnostics).toMatchObject({
		visibleTextLength,
		reasoningTextLength: 0,
	});
});

it("rejects reasoning-only chat output with diagnostics", async () => {
	const response = responseStream(
		{
			id: "chat_reasoning",
			choices: [{ delta: { reasoning_content: "thinking" } }],
		},
		{
			id: "chat_reasoning",
			choices: [{ delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	);
	const error = await Effect.runPromise(
		Effect.flip(readOpenAIResponseStreamEffect(response)),
	);
	expect((error as OpenAIStreamError).diagnostics).toEqual({
		responseId: "chat_reasoning",
		finishReason: "stop",
		visibleTextLength: 0,
		reasoningTextLength: 8,
	});
});

it("rejects length-truncated chat output without visible content", async () => {
	const response = responseStream(
		{
			id: "chat_length",
			choices: [{ delta: {}, finish_reason: "length" }],
		},
		"[DONE]",
	);
	const error = await Effect.runPromise(
		Effect.flip(readOpenAIResponseStreamEffect(response)),
	);
	expect((error as OpenAIStreamError).diagnostics).toEqual({
		responseId: "chat_length",
		finishReason: "length",
		visibleTextLength: 0,
		reasoningTextLength: 0,
	});
});
```

Update the existing successful stream and Chat Completions assertions to expect
diagnostics and the real response ID only:

```ts
expect(result.diagnostics).toEqual({
	responseId: "resp_1",
	visibleTextLength: 21,
	reasoningTextLength: 0,
});
expect(state.finishReason).toBe("stop");
expect(state.reasoningTextLength).toBe(0);
```

- [ ] **Step 2: Run the transport tests and verify RED**

Run:

```bash
pnpm test src/lib/openai-response-runtime.test.ts
```

Expected: FAIL because `OpenAIStreamError`, diagnostics, finish reason, and
reasoning length do not exist and blank streams currently resolve.

- [ ] **Step 3: Implement stream diagnostics and blank rejection**

Add these public types and helpers:

```ts
export interface OpenAIStreamDiagnostics {
	responseId?: string;
	finishReason?: string;
	visibleTextLength: number;
	reasoningTextLength: number;
}

export class OpenAIStreamError extends Error {
	constructor(
		message: string,
		readonly diagnostics: OpenAIStreamDiagnostics,
	) {
		super(
			`${message} (finishReason=${diagnostics.finishReason ?? "unknown"}, visibleTextLength=${String(diagnostics.visibleTextLength)}, reasoningTextLength=${String(diagnostics.reasoningTextLength)}, responseId=${diagnostics.responseId ?? "unknown"})`,
		);
		this.name = "OpenAIStreamError";
	}
}

export function isOpenAIStreamDiagnostics(
	value: unknown,
): value is OpenAIStreamDiagnostics {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const diagnostics = value as Partial<OpenAIStreamDiagnostics>;
	return (
		(diagnostics.responseId === undefined ||
			typeof diagnostics.responseId === "string") &&
		(diagnostics.finishReason === undefined ||
			typeof diagnostics.finishReason === "string") &&
		typeof diagnostics.visibleTextLength === "number" &&
		Number.isFinite(diagnostics.visibleTextLength) &&
		diagnostics.visibleTextLength >= 0 &&
		typeof diagnostics.reasoningTextLength === "number" &&
		Number.isFinite(diagnostics.reasoningTextLength) &&
		diagnostics.reasoningTextLength >= 0
	);
}

export function openAIStreamDiagnosticsFromError(error: unknown) {
	return error instanceof OpenAIStreamError ? error.diagnostics : undefined;
}
```

Extend `OpenAIStreamState` with `finishReason?: string` and
`reasoningTextLength: number`, initialize the latter to zero, and expose
`diagnostics` on `OpenAIStreamResult`.

In `handleOpenAIEvent`, count string deltas for
`response.reasoning_text.delta` and
`response.reasoning_summary_text.delta`. For `response.incomplete`, retain the
response ID/usage and assign the incomplete reason to `finishReason` before
setting the existing error.

Replace the Chat Completions normalization branch with direct state updates so
one frame can contain content, reasoning, and terminal metadata:

```ts
if (typeof parsed.id === "string") state.responseId = parsed.id;
if (parsed.usage !== undefined) state.usage = parsed.usage;
const delta = choice.delta as Record<string, unknown> | undefined;
const content = delta?.content;
if (typeof content === "string") {
	emitVisibleDelta(state, content, onDelta, delimiterPattern, delimiterHold);
}
for (const reasoning of [delta?.reasoning_content, delta?.reasoning]) {
	if (typeof reasoning === "string") state.reasoningTextLength += reasoning.length;
}
if (typeof choice.finish_reason === "string") {
	state.finishReason = choice.finish_reason;
}
shouldHandle = false;
```

Apply the same top-level ID/usage capture when `choices` is empty. For Responses
API `completed`, `failed`, and `incomplete` terminal events, capture ID and usage
from `event.response`; for incomplete responses also use
`incomplete_details.reason` as the finish reason.

At EOF, build diagnostics once and reject trimmed-empty output:

```ts
const diagnostics: OpenAIStreamDiagnostics = {
	...(state.responseId ? { responseId: state.responseId } : {}),
	...(state.finishReason ? { finishReason: state.finishReason } : {}),
	visibleTextLength: state.rawText.length,
	reasoningTextLength: state.reasoningTextLength,
};
if (state.error) return yield* Effect.fail(new OpenAIStreamError(state.error, diagnostics));
if (!state.rawText.trim()) {
	return yield* Effect.fail(
		new OpenAIStreamError("OpenAI stream returned no visible output", diagnostics),
	);
}
return {
	rawText: state.rawText,
	diagnostics,
	...(state.responseId ? { responseId: state.responseId } : {}),
	...(state.usage === undefined ? {} : { usage: state.usage }),
};
```

- [ ] **Step 4: Run the transport tests and verify GREEN**

Run `pnpm test src/lib/openai-response-runtime.test.ts`.

Expected: PASS with no warnings other than the repository's Node engine warning.

- [ ] **Step 5: Commit the transport boundary**

```bash
git add src/lib/openai-response-runtime.ts src/lib/openai-response-runtime.test.ts
git commit -m "fix: reject blank OpenAI streams"
```

### Task 2: Propagate Hybrid Diagnostics and Reject Blank Non-Stream Output

**Files:**
- Modify: `src/lib/analysis-runtime.test.ts:45-127`
- Modify: `src/lib/analysis-runtime.ts:33-277`

- [ ] **Step 1: Write failing hybrid-runtime tests**

Import `readHybridAnalysisStreamEffect`, add a successful stream fixture, and
assert the transport diagnostics reach the hybrid result:

```ts
it("propagates stream diagnostics through hybrid analysis", async () => {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					'data: {"choices":[{"delta":{"content":"Visible"}}],"id":"chat_1"}\n\n' +
						'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"id":"chat_1"}\n\n',
				),
			);
			controller.close();
		},
	});
	const result = await Effect.runPromise(
		readHybridAnalysisStreamEffect(new Response(stream), {
			parse: (value) => value,
			fallback: (markdown) => ({ markdown }),
		}),
	);
	expect(result.diagnostics).toEqual({
		responseId: "chat_1",
		finishReason: "stop",
		visibleTextLength: 7,
		reasoningTextLength: 0,
	});
});
```

Add a non-stream response whose `output_text` is whitespace and assert
`requestHybridAnalysisEffect` rejects with `OpenAI returned no output text`.

- [ ] **Step 2: Run the analysis-runtime tests and verify RED**

Run `pnpm test src/lib/analysis-runtime.test.ts`.

Expected: FAIL because hybrid results omit diagnostics and whitespace passes the
current truthiness check.

- [ ] **Step 3: Implement minimal propagation and trimmed validation**

Add an optional diagnostic field so non-stream callers remain compatible:

```ts
export interface HybridAnalysisResult<T> {
	value: T;
	markdown: string;
	rawText: string;
	parseStatus: "structured" | "fallback";
	fallbackReason?: string;
	responseId?: string;
	usage?: unknown;
	diagnostics?: OpenAIStreamDiagnostics;
}
```

In `readHybridAnalysisStreamEffect`, add `diagnostics: stream.diagnostics` to
the returned object. In `requestHybridAnalysisEffect`, change the guard to:

```ts
if (!rawText.trim()) {
	return yield* Effect.fail(new Error("OpenAI returned no output text"));
}
```

- [ ] **Step 4: Run the analysis tests and verify GREEN**

Run `pnpm test src/lib/analysis-runtime.test.ts`.

Expected: PASS.

- [ ] **Step 5: Commit hybrid propagation**

```bash
git add src/lib/analysis-runtime.ts src/lib/analysis-runtime.test.ts
git commit -m "fix: propagate OpenAI stream diagnostics"
```

### Task 3: Define and Enforce Digest Displayability Before Cache Writes

**Files:**
- Create: `src/lib/period-digest-integrity.ts`
- Create: `src/lib/period-digest-integrity.test.ts`
- Modify: `src/lib/period-digest.ts:88-98,1024-1065,1314-1370`
- Modify: `src/lib/period-digest.test.ts:530-574,1001-1024,1079-1100`

- [ ] **Step 1: Write failing integrity contract tests**

Create `period-digest-integrity.test.ts` with a complete base digest and these
cases:

```ts
const digest: PeriodDigest = {
	title: "Today",
	summary: "Useful output",
	keyTopics: [],
	notableLinks: [],
	people: [],
	actionItems: [],
	sourceTweetIds: [],
};

it("accepts structured and non-empty fallback prose", () => {
	expect(
		isDisplayablePeriodDigest({ digest, markdown: "# Today", parseStatus: "structured" }),
	).toBe(true);
	expect(
		isDisplayablePeriodDigest({
			digest: { ...digest, title: "Today digest", summary: "Fallback prose" },
			markdown: "Fallback prose",
			parseStatus: "fallback",
		}),
	).toBe(true);
});

it.each(["", "  \n\t"])("rejects blank Markdown %j", (markdown) => {
	expect(
		isDisplayablePeriodDigest({ digest, markdown, parseStatus: "structured" }),
	).toBe(false);
});

it("rejects language and sentinel fallback placeholders", () => {
	for (const placeholder of [
		{ title: "[zh-CN]", summary: "[zh-CN]" },
		{ title: "Today digest", summary: "No model summary was returned." },
	]) {
		expect(
			isDisplayablePeriodDigest({
				digest: { ...digest, ...placeholder },
				markdown: "# Placeholder shell",
				parseStatus: "fallback",
			}),
		).toBe(false);
	}
});
```

Also assert `assertDisplayablePeriodDigest` throws
`Period digest did not contain displayable content` for invalid inputs.

- [ ] **Step 2: Run the new contract test and verify RED**

Run `pnpm test src/lib/period-digest-integrity.test.ts`.

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the focused integrity module**

```ts
import type { PeriodDigest } from "./analysis-result-contracts";

export interface DisplayablePeriodDigestInput {
	digest: PeriodDigest;
	markdown: string;
	parseStatus: "structured" | "fallback";
}

const LANGUAGE_PLACEHOLDER = /^\[[^\]\r\n]+\]$/;
const EMPTY_SUMMARY = "No model summary was returned.";

function hasStructuredDetails(digest: PeriodDigest) {
	return (
		digest.keyTopics.length > 0 ||
		digest.notableLinks.length > 0 ||
		digest.people.length > 0 ||
		digest.actionItems.length > 0
	);
}

export function isDisplayablePeriodDigest(input: DisplayablePeriodDigestInput) {
	if (!input.markdown.trim()) return false;
	if (input.parseStatus !== "fallback") return true;
	const title = input.digest.title.trim();
	const summary = input.digest.summary.trim();
	const placeholderOnly =
		(LANGUAGE_PLACEHOLDER.test(title) && LANGUAGE_PLACEHOLDER.test(summary)) ||
		summary === EMPTY_SUMMARY;
	return !placeholderOnly || hasStructuredDetails(input.digest);
}

export function assertDisplayablePeriodDigest(
	input: DisplayablePeriodDigestInput,
): void {
	if (!isDisplayablePeriodDigest(input)) {
		throw new Error("Period digest did not contain displayable content");
	}
}
```

- [ ] **Step 4: Run the contract test and verify GREEN**

Run `pnpm test src/lib/period-digest-integrity.test.ts`.

Expected: PASS.

- [ ] **Step 5: Write a failing generation-cache boundary test**

In `period-digest.test.ts`, stream delimiter-plus-JSON output with no Markdown,
capture the sync-cache row count before the call, and assert rejection plus no
new cache rows:

```ts
it("rejects an empty display body before writing digest caches", async () => {
	const db = getNativeDb();
	const before = db.prepare("select count(*) as count from sync_cache").get() as {
		count: number;
	};
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			streamResponse(
				sseFrame({
					type: "response.output_text.delta",
					delta:
						'\n---\n{"title":"[zh-CN]","summary":"[zh-CN]","keyTopics":[],"notableLinks":[],"people":[],"actionItems":[],"sourceTweetIds":[]}',
				}),
			),
		),
	);
	await expect(
		streamPeriodDigest({
			since: "2026-01-01T00:00:00.000Z",
			until: "2027-01-01T00:00:00.000Z",
			refresh: true,
		}),
	).rejects.toThrow("displayable content");
	const after = db.prepare("select count(*) as count from sync_cache").get() as {
		count: number;
	};
	expect(after.count).toBe(before.count);
});
```

- [ ] **Step 6: Run the period-digest boundary test and verify RED**

Run `pnpm test src/lib/period-digest.test.ts -t "empty display body"`.

Expected: FAIL because the structured placeholder currently reaches cache
writes.

- [ ] **Step 7: Validate before caches and carry diagnostics**

Add `diagnostics?: OpenAIStreamDiagnostics` to `PeriodDigestRunResult` and
`CachedPeriodDigestValue`. At the start of `completeOpenAIStreamEffect`, before
context enrichment or any `writeSyncCache`, call:

```ts
yield* tryDigestSync(() =>
	assertDisplayablePeriodDigest({
		digest: stream.value,
		markdown: stream.markdown,
		parseStatus: stream.parseStatus,
	}),
);
```

Write `stream.diagnostics` into exact-cache values and the returned result when
present. Include diagnostics in the legacy latest generation cache and restore
them in `cachedDigestResult` when present.

- [ ] **Step 8: Run focused digest tests and verify GREEN**

Run:

```bash
pnpm test src/lib/period-digest-integrity.test.ts src/lib/period-digest.test.ts
```

Expected: PASS, including the existing localized non-empty fallback test.

- [ ] **Step 9: Commit the digest integrity boundary**

```bash
git add src/lib/period-digest-integrity.ts src/lib/period-digest-integrity.test.ts src/lib/period-digest.ts src/lib/period-digest.test.ts
git commit -m "fix: reject non-displayable period digests"
```

### Task 4: Harden Current Publication and Recover Invalid Stable Rows

**Files:**
- Modify: `src/lib/period-digest-current-store.test.ts:76-374`
- Modify: `src/lib/period-digest-current-store.ts:30-376`

- [ ] **Step 1: Write failing current-store rejection tests**

Extend the stable-row invalid cases with `markdown: ""` and
`markdown: " \n\t"`. Add a publication test that first publishes a valid row,
then tries to publish invalid replacements and asserts both calls throw while
the old `versionId`, `generatedAt`, and Markdown remain unchanged.

Add a placeholder candidate with:

```ts
{
	...valid,
	markdown: "# Placeholder shell",
	parseStatus: "fallback",
	digest: {
		...valid.digest,
		title: "[zh-CN]",
		summary: "[zh-CN]",
		keyTopics: [],
		notableLinks: [],
		people: [],
		actionItems: [],
	},
}
```

Expect it to read as null and fail publication.

- [ ] **Step 2: Write a failing invalid-current recovery test**

Write an invalid stable current row directly, then write one empty newer legacy
candidate and one older valid legacy candidate. Run migration and assert the
valid legacy candidate replaces the invalid stable row:

```ts
expect(migration.migrated).toContainEqual({ period: "24h", contentSource: "all" });
expect(readCurrentPeriodDigest("24h", "all", db)).toMatchObject({
	markdown: "# Previous valid All",
	generatedAt: "2026-08-06T17:23:50.189Z",
	migratedFromLegacy: true,
});
```

- [ ] **Step 3: Run current-store tests and verify RED**

Run `pnpm test src/lib/period-digest-current-store.test.ts`.

Expected: FAIL because blank/placeholder rows are accepted, publication writes
them, and migration treats any raw stable row as authoritative.

- [ ] **Step 4: Enforce the shared contract on write and read paths**

Call `assertDisplayablePeriodDigest(input.result)` at the start of
`publishCurrentPeriodDigest`. In `parseCurrentPeriodDigest`, after schema
validation, return null unless `isDisplayablePeriodDigest` accepts the parsed
digest, Markdown, and parse status.

In `parseLegacyCandidate`, apply the same predicate after schema validation and
return `invalid-payload` for an invalid candidate.

Persist optional result diagnostics on `CurrentPeriodDigestV1`, validate them
with the exported OpenAI diagnostic type guard, and copy them during publish and
legacy migration without making them required for old rows.

- [ ] **Step 5: Allow migration to replace only invalid stable rows**

Replace the raw presence check:

```ts
if (readSyncCache(logicalKey, db)) {
```

with the validated lookup:

```ts
if (readCurrentPeriodDigest(candidate.period, candidate.contentSource, db)) {
```

This preserves valid stable values but permits recovery when a raw row exists
and fails the current parser.

- [ ] **Step 6: Run current-store tests and verify GREEN**

Run `pnpm test src/lib/period-digest-current-store.test.ts`.

Expected: PASS.

- [ ] **Step 7: Commit current-store hardening**

```bash
git add src/lib/period-digest-current-store.ts src/lib/period-digest-current-store.test.ts
git commit -m "fix: protect current digest publication"
```

### Task 5: Retry Invalid Results and Persist Run Diagnostics

**Files:**
- Modify: `src/lib/period-digest-orchestrator.test.ts:504-590`
- Modify: `src/lib/period-digest-orchestrator.ts:18-30,61-67,700-823`

- [ ] **Step 1: Write a failing retry-and-isolation test**

Publish an old All current. Configure `maxGenerateAttempts: 2` and make the
injected generator return, rather than throw, a whitespace-only All result on
both attempts while returning valid Following and For You results.

Assert:

```ts
expect(generate).toHaveBeenCalledTimes(4);
expect(finalState.phase).toBe("degraded");
expect(finalState.sources.all).toMatchObject({ state: "failed", attempts: 2 });
expect(readCurrentPeriodDigest("today", "all", db)).toMatchObject({
	versionId: "old-version",
	generatedAt: "2026-08-06T06:00:00.000Z",
});
expect(readCurrentPeriodDigest("today", "following", db)).not.toBeNull();
expect(readCurrentPeriodDigest("today", "for_you", db)).not.toBeNull();
```

- [ ] **Step 2: Write failing completed/failed diagnostic audit tests**

Return a valid result with:

```ts
diagnostics: {
	responseId: "resp_success",
	finishReason: "stop",
	visibleTextLength: 120,
	reasoningTextLength: 40,
}
```

and assert the completed source state retains it. In a separate source failure,
throw `new OpenAIStreamError("OpenAI stream returned no visible output", {...})`
and assert the failed source state and the object passed to `audit` retain the
same structured diagnostics.

- [ ] **Step 3: Run orchestrator tests and verify RED**

Run `pnpm test src/lib/period-digest-orchestrator.test.ts`.

Expected: FAIL because invalid returned results bypass retries and source state
does not include diagnostics.

- [ ] **Step 4: Validate generated results inside the retry loop**

Immediately after `dependencies.generate` resolves and before clearing
`generationError`, call:

```ts
assertDisplayablePeriodDigest({
	digest: generated.digest,
	markdown: generated.markdown,
	parseStatus: generated.parseStatus,
});
```

The existing catch/retry logic will now handle semantic generation failures.

- [ ] **Step 5: Persist diagnostics for terminal source states**

Add optional `diagnostics?: OpenAIStreamDiagnostics` to
`PeriodDigestSourceRunState`. When marking a source completed, copy
`generated.diagnostics` when present. When marking it failed, extract
diagnostics from `generationError` or the publication error:

```ts
const diagnostics = openAIStreamDiagnosticsFromError(error);
// ...
[contentSource]: {
	state: "failed",
	attempts,
	error: sensitiveErrorMessage(error),
	...(diagnostics ? { diagnostics } : {}),
},
```

Because final run state is already passed to `appendScheduledJobAudit`, no new
logging channel or raw-output persistence is needed.

- [ ] **Step 6: Run orchestrator tests and verify GREEN**

Run `pnpm test src/lib/period-digest-orchestrator.test.ts`.

Expected: PASS.

- [ ] **Step 7: Commit retry and audit behavior**

```bash
git add src/lib/period-digest-orchestrator.ts src/lib/period-digest-orchestrator.test.ts
git commit -m "fix: retry invalid digest results"
```

### Task 6: Keep Metadata and UI Status Consistent

**Files:**
- Modify: `src/routes/api/period-digest-metadata.test.ts:52-183`
- Modify: `src/routes/api/period-digest-metadata.tsx:41-56`
- Modify: `src/routes/today.test.tsx:118-323`
- Modify: `src/routes/today.tsx:543-595`

- [ ] **Step 1: Write a failing metadata test**

Mock a current digest with `markdown: " \n"` and assert the API returns
`result: null`, `isStale: true`, and never exposes `cached: true`.

First expand the existing `currentDigest` fixture from its partial
`{ actionItems: [] }` value to a complete valid digest so the test exercises
only the Markdown condition:

```ts
digest: {
	title: "Existing Today",
	summary: "Existing summary",
	keyTopics: [],
	notableLinks: [],
	people: [],
	actionItems: [],
	sourceTweetIds: [],
},
```

Add a recovery-attempt regression that first returns a valid current, later
returns an invalid/missing current for the same page, and verifies migration is
allowed once for that new invalid episode. Repeated missing polls without an
intervening valid value must not rescan legacy caches.

- [ ] **Step 2: Write a failing UI contradiction test**

Return metadata containing `digestResult("Today", "")`, render Today, and
assert:

```ts
expect(await screen.findByText("Waiting for the first tokens...")).toBeVisible();
expect(screen.queryByText(/^Cached/)).toBeNull();
expect(screen.queryByLabelText("Generated at")).toBeNull();
```

- [ ] **Step 3: Run route tests and verify RED**

Run:

```bash
pnpm test src/routes/api/period-digest-metadata.test.ts src/routes/today.test.tsx
```

Expected: FAIL because metadata and status currently trust any result object.

- [ ] **Step 4: Gate metadata conversion with displayability**

At the start of `resultFromCurrent`, return null unless the shared predicate
accepts current digest, Markdown, and parse status:

```ts
if (
	!current ||
	!isDisplayablePeriodDigest({
		digest: current.digest,
		markdown: current.markdown,
		parseStatus: current.parseStatus,
	})
) {
	return null;
}
```

Compute `isStale` from the validated `result` so an invalid mocked/bypass current
cannot look fresh:

```ts
const isStale = result ? !isFreshDigestCache(result.updatedAt, period) : true;
```

Replace the process-wide migration boolean with a set of logical page keys. A
valid current read clears its key. A missing/invalid read adds the key and runs
migration only when the key was not already present:

```ts
const legacyMigrationAttempts = new Set<string>();

function recoverCurrentOnce(
	period: CurrentPeriodDigestPeriod,
	contentSource: PeriodDigestContentSource,
) {
	const key = `${period}:${contentSource}`;
	if (legacyMigrationAttempts.has(key)) return null;
	legacyMigrationAttempts.add(key);
	return migrateLegacyPeriodDigests();
}
```

When a valid current is read, call
`legacyMigrationAttempts.delete(`${period}:${contentSource}`)`. This keeps empty
first-use polling bounded while allowing recovery if a previously valid current
becomes invalid later in the same server process.

- [ ] **Step 5: Gate Today status and timestamp with Markdown**

Define `const hasDisplayableMarkdown = Boolean(markdown.trim())` beside the
existing derived view state. Use it in the status and timestamp branches:

```tsx
: result && hasDisplayableMarkdown
	? `${result.cached ? "Cached" : "Ready"} · ${result.context.window.label}`
	: digestError

{result && hasDisplayableMarkdown && exportUpdatedAt ? (
	<time aria-label="Generated at" dateTime={result.updatedAt}>
		Generated {exportUpdatedAt}
	</time>
) : null}
```

Use `hasDisplayableMarkdown` for the MarkdownViewer branch as well.

- [ ] **Step 6: Run route tests and verify GREEN**

Run:

```bash
pnpm test src/routes/api/period-digest-metadata.test.ts src/routes/today.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit API/UI consistency**

```bash
git add src/routes/api/period-digest-metadata.tsx src/routes/api/period-digest-metadata.test.ts src/routes/today.tsx src/routes/today.test.tsx
git commit -m "fix: align digest cache and empty states"
```

### Task 7: Cross-Layer Verification

**Files:**
- Modify only if a verification command exposes a defect in the files above.

- [ ] **Step 1: Run the issue-focused regression suite**

```bash
pnpm test src/lib/openai-response-runtime.test.ts src/lib/analysis-runtime.test.ts src/lib/period-digest-integrity.test.ts src/lib/period-digest.test.ts src/lib/period-digest-current-store.test.ts src/lib/period-digest-orchestrator.test.ts src/routes/api/period-digest-metadata.test.ts src/routes/today.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 2: Run static checks**

```bash
pnpm check
```

Expected: formatting, lint, and TypeScript checks pass.

- [ ] **Step 3: Run the complete test suite**

```bash
pnpm test
```

Expected: all test files pass. Run outside the filesystem sandbox if the
production-server tests report `listen EPERM` on `127.0.0.1`.

- [ ] **Step 4: Run the production build**

```bash
pnpm build
```

Expected: Vite client/server and CLI bundles build successfully.

- [ ] **Step 5: Inspect the final patch**

```bash
git diff main...HEAD --check
git status --short --branch
git log --oneline main..HEAD
```

Expected: no whitespace errors, a clean worktree, and only issue #53 design,
plan, tests, and implementation commits.

### Task 8: Address PR Review Feedback

**Files:**
- Modify: `src/lib/period-digest-orchestrator.test.ts`
- Modify: `src/lib/period-digest-orchestrator.ts`
- Modify: `src/lib/period-digest-integrity.test.ts`
- Modify: `src/lib/period-digest-integrity.ts`
- Modify: `src/lib/period-digest.test.ts`
- Modify: `src/lib/period-digest.ts`

- [ ] **Step 1: Reproduce malformed run-state handling**

Add a run-state read test whose `sources` object contains a valid source and
non-object entries such as `null`, an array, and a string. Assert that the valid
source remains, diagnostics are canonicalized, and invalid entries are absent.

Run:

```bash
pnpm test src/lib/period-digest-orchestrator.test.ts
```

Expected: FAIL because `parseRunState` currently preserves the malformed source
entries.

- [ ] **Step 2: Normalize source entries in `parseRunState`**

Filter `Object.entries(state.sources)` before diagnostics projection:

```ts
.flatMap(([source, sourceState]) => {
	if (!sourceState || typeof sourceState !== "object" || Array.isArray(sourceState)) {
		return [];
	}
	const { diagnostics: untrustedDiagnostics, ...rest } = sourceState;
	const diagnostics = sanitizeOpenAIStreamDiagnostics(untrustedDiagnostics);
	return [[source, { ...rest, ...(diagnostics ? { diagnostics } : {}) }]];
})
```

Run the orchestrator test again. Expected: PASS.

- [ ] **Step 3: Reproduce structured sentinel misclassification**

Add integrity tests proving that the same sentinel-only digest is rejected for
`parseStatus: "fallback"` but accepted for `parseStatus: "structured"` when its
Markdown is non-empty.

Run:

```bash
pnpm test src/lib/period-digest-integrity.test.ts
```

Expected: FAIL because placeholder matching currently ignores `parseStatus`.

- [ ] **Step 4: Make placeholder matching fallback-specific**

Use `parseStatus` in `isPlaceholderOnlyDigest` and export the period-digest
fallback sentinel values from the same module. Update `fallbackDigest` to build
its title and summary from those exports rather than duplicate string literals.

Run:

```bash
pnpm test src/lib/period-digest-integrity.test.ts src/lib/period-digest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Reuse canonical diagnostics**

In `completeOpenAIStreamEffect`, sanitize `stream.diagnostics` once before the
exact-cache write and reuse the value in the returned result and latest-cache
write.

- [ ] **Step 6: Verify and commit the review fixes**

Run:

```bash
pnpm test src/lib/period-digest-orchestrator.test.ts src/lib/period-digest-integrity.test.ts src/lib/period-digest.test.ts src/routes/api/period-digest-metadata.test.ts
pnpm check
pnpm test
pnpm build
git diff --check
```

Expected: all tests and checks pass. Then commit the focused source and test
changes and push the branch so PR #55 reruns CI.
