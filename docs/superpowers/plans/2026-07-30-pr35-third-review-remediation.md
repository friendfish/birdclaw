# PR 35 Third Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every validated third-review finding by preventing stale Playground state, extracting and behavior-testing the prompt panel, sharing locked prompt instructions, aligning reset errors, documenting prompt ordering, and enforcing exact Playground result schemas.

**Architecture:** Keep `ConfigRoute` responsible for top-level settings and move prompt editing into a focused `PromptTemplatesPanel`. Model each Playground request as an identity-bearing run whose callbacks may update state only while that identity remains active. Move structured AI result schemas into a client-safe shared module so runtimes and browser contracts enforce the same shapes without forced casts.

**Tech Stack:** TypeScript 7, React 19, TanStack Start, Effect, Zod, Vitest 4, Testing Library, pnpm.

---

### Task 1: Reproduce and Fix Cross-Feature Playground State

**Files:**
- Create: `src/routes/config.test.tsx`
- Modify: `src/routes/config.tsx`

- [ ] **Step 1: Add a failing route-level regression test**

Render the existing Config route with deterministic responses for config,
schedule, profile metadata, and prompt templates. Hold the Today Playground
request before response headers, switch to Analyse, resolve the old Today stream,
and assert both cancellation and stale-output suppression:

```tsx
fireEvent.click(await screen.findByRole("button", { name: "提示词" }));
fireEvent.click(await screen.findByRole("button", { name: "Run" }));
await waitFor(() => expect(todayRun).not.toBeNull());
fireEvent.click(screen.getByRole("button", { name: "Analyse" }));

expect(todayRun?.signal.aborted).toBe(true);
todayRun?.resolve(ndjsonResponse([
	{ type: "delta", delta: "stale Today output" },
	{ type: "done", result: periodResult("stale Today output") },
]));
expect(screen.queryByText("stale Today output")).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the regression test and verify RED**

Run:

```bash
pnpm vitest run src/routes/config.test.tsx
```

Expected: FAIL because the Today signal is not aborted and late callbacks can
write into Analyse state.

- [ ] **Step 3: Add an identity-bearing active-run boundary**

Capture a unique run record and guard every asynchronous update:

```tsx
interface ActiveRun {
	id: symbol;
	feature: PromptFeature;
	controller: AbortController;
}

const activeRunRef = useRef<ActiveRun | null>(null);
const isActiveRun = (run: ActiveRun) => activeRunRef.current?.id === run.id;
```

Starting, stopping, switching feature, and unmounting must retire and abort the
record. Delta, done, error, non-streaming response, and `finally` handlers must
return without changing state when `isActiveRun(run)` is false.

- [ ] **Step 4: Re-run the regression test and verify GREEN**

Run the focused test. Expected: PASS.

### Task 2: Extract and Behavior-Test the Prompt Panel

**Files:**
- Create: `src/components/PromptTemplatesPanel.tsx`
- Create: `src/components/PromptTemplatesPanel.test.tsx`
- Modify: `src/routes/config.tsx`
- Delete: `src/routes/config.prompt-copy.test.ts`

- [ ] **Step 1: Add route-level behavioral tests for protected UI paths**

Test rendered behavior rather than source text:

```tsx
expect(await screen.findByText(/invalidates matching AI caches/i)).toBeVisible();
expect(screen.getByText(/may incur real AI usage charges/i)).toBeVisible();

vi.spyOn(window, "confirm").mockReturnValue(false);
fireEvent.click(screen.getByRole("button", { name: "Save template" }));
expect(saveRequests()).toHaveLength(0);
```

Cover accepted corrupt overwrite, save/reset success and failure, Today and
Discuss stream success/error/Stop, Analyse success/error, advanced preview,
template load failure, and empty profile metadata.

- [ ] **Step 2: Run the tests against the existing panel boundary**

Run:

```bash
pnpm vitest run src/routes/config.test.tsx
```

Expected: existing behavior assertions pass after Task 1. Any newly exposed
unhandled API branch fails as a user-visible behavior assertion, not as a missing
module error; fix that branch with its own red-green cycle before extraction.

- [ ] **Step 3: Extract without changing behavior**

Move prompt-only imports, helpers, state, effects, handlers, and JSX to the new
component. Export:

```tsx
export function PromptTemplatesPanel({ aiLanguage }: { aiLanguage: string }) {
	// prompt-only implementation
}
```

Keep `ConfigRoute` responsible only for the top-level tab and render:

```tsx
<PromptTemplatesPanel aiLanguage={aiLanguage} />
```

Move prompt-panel-specific test cases to
`src/components/PromptTemplatesPanel.test.tsx` and render the exported component
directly. Delete the regex-based source-copy test after equivalent rendered
assertions are green.

- [ ] **Step 4: Run component and Config tests and verify GREEN**

Expected: all focused tests pass.

### Task 3: Share the Fixed Task Instruction and Record Prompt Ordering

**Files:**
- Modify: `src/lib/prompt-templates.ts`
- Modify: `src/lib/prompt-templates.test.ts`
- Modify: `src/lib/period-digest.ts`
- Modify: `src/lib/period-digest.test.ts`
- Modify: `src/lib/profile-analysis.ts`
- Modify: `src/lib/profile-analysis.test.ts`
- Modify: `src/lib/search-discussion.ts`
- Modify: `src/lib/search-discussion.test.ts`
- Modify: `src/lib/prompt-playground-contracts.ts`
- Modify: `src/routes/api/prompt-templates.tsx`
- Modify: `src/routes/api/prompt-templates.reset.tsx`
- Modify: `src/components/PromptTemplatesPanel.test.tsx`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add failing materialization and preview assertions**

Require a task instruction in the locked protocol and prove it affects both the
materialized prompt and hash:

```ts
const first = materializeEffectivePrompt(editable, {
	system: "Protocol",
	taskInstruction: "Task A",
	requirements: "Shape",
});
const second = materializeEffectivePrompt(editable, {
	system: "Protocol",
	taskInstruction: "Task B",
	requirements: "Shape",
});
expect(first.taskInstruction).toBe("Task A");
expect(first.promptHash).not.toBe(second.promptHash);
```

In the component test, enable Advanced mode and assert the exact Today, Analyse,
and Discuss task instruction appears after each feature selection.

- [ ] **Step 2: Run focused tests and verify RED**

Expected: compile/assertion failure because `taskInstruction` is not part of the
protocol or response contract and the preview omits it.

- [ ] **Step 3: Add the shared field and use it in production builders**

Add `taskInstruction` to `PromptProtocol` and `EffectivePrompt`, include it in
the SHA-256 input, return it through the template API definition, render it in
the advanced header preview, and replace each hard-coded builder instruction
with `${effectivePrompt.taskInstruction}`.

- [ ] **Step 4: Document the compatibility-visible order change**

Add a `Changed` entry under `0.11.1 - Unreleased` stating that editable and
locked prompt segmentation changes the default Today and Discuss sentence and
citation-rule ordering compared with 0.11.0.

- [ ] **Step 5: Re-run focused tests and verify GREEN**

Run prompt-template and all three feature tests plus component tests.

### Task 4: Align Reset Filesystem Errors with Save

**Files:**
- Modify: `src/routes/api/prompt-templates.test.ts`
- Modify: `src/routes/api/prompt-templates.reset.tsx`

- [ ] **Step 1: Add a real failing filesystem test**

Create a directory where the fixed template file should be, then call reset:

```ts
mkdirSync(promptTemplateTest.promptPath("period-digest"), { recursive: true });
const response = await RESET({ request: resetRequest("period-digest") });
expect(response.status).toBe(400);
expect((await response.json()).message).toMatch(/directory|EISDIR/u);
```

- [ ] **Step 2: Run the route test and verify RED**

Expected: FAIL because the exception escapes to the generic route 500 path.

- [ ] **Step 3: Wrap reset in `Effect.try`**

Use the save route's pattern to return a concrete JSON failure:

```ts
return yield* Effect.try({
	try: () => jsonResponse(responseFor(resetPromptTemplate(parsed.data.feature))),
	catch: (error) => jsonResponse(
		{ ok: false, message: error instanceof Error ? error.message : "Unable to reset prompt template" },
		{ status: 400 },
	),
}).pipe(Effect.merge);
```

- [ ] **Step 4: Re-run the route test and verify GREEN**

Expected: PASS.

### Task 5: Replace Loose Playground Result Contracts

**Files:**
- Create: `src/lib/analysis-result-contracts.ts`
- Create: `src/lib/analysis-result-contracts.test.ts`
- Modify: `src/lib/period-digest.ts`
- Modify: `src/lib/profile-analysis.ts`
- Modify: `src/lib/search-discussion.ts`
- Modify: `src/lib/prompt-playground-contracts.ts`
- Modify: `src/lib/prompt-playground-contracts.test.ts`

- [ ] **Step 1: Add failing nested-result validation tests**

For each Playground response/event, pass an object with required envelope fields
but an invalid empty structured value and require rejection:

```ts
expect(periodDigestPlaygroundStreamEventSchema.safeParse({
	type: "done",
	result: { markdown: "Report", digest: {}, parseStatus: "structured", generatedAt: now },
}).success).toBe(false);
```

Repeat for `analysis` and `discussion`.

- [ ] **Step 2: Run contract tests and verify RED**

Expected: FAIL because `z.looseObject({})` accepts each invalid nested value.

- [ ] **Step 3: Move exact result schemas to a client-safe module**

Define and export `periodDigestSchema`, `profileAnalysisSchema`, and
`searchDiscussionSchema` plus their inferred types without importing Node,
database, or transport modules. Import them from feature runtimes and Playground
contracts. Type event schemas directly as `z.ZodType<PlaygroundStreamEvent<T>>`;
remove every `as unknown` in the Playground contract file.

- [ ] **Step 4: Run contract and feature tests and verify GREEN**

Expected: all focused tests pass and invalid nested values are rejected.

### Task 6: Coverage, Full Verification, and PR Update

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-pr35-third-review-remediation.md`
- GitHub: PR 35 description and third-review reply

- [ ] **Step 1: Run coverage and close uncovered prompt-panel branches**

Run:

```bash
pnpm coverage
```

Expected: lines/functions/statements remain at least 85%, branches reach at least
80%, and branch coverage is not below the `origin/main` baseline. Add only
behavioral tests for genuinely reachable uncovered branches.

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm run check
pnpm test
pnpm run build
git diff --check origin/main...HEAD
```

Expected: all commands pass. Run tests outside the sandbox if the production
server cannot bind `127.0.0.1`.

- [ ] **Step 3: Commit and push safely**

Stage only the explicit prompt remediation files, commit, fetch the remote PR
head, then push with `--force-with-lease` only if the remote still matches the
known local base.

- [ ] **Step 4: Update PR metadata and answer the review**

Record the six remediations and exact verification counts in the PR body. Reply
to the third-review top-level comment with the commit, P0 lifecycle behavior,
component coverage evidence, task-instruction source, reset error behavior,
changelog note, and exact schema change. Confirm GitHub reports
`MERGEABLE/CLEAN`.
