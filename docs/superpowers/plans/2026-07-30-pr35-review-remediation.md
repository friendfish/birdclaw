# PR 35 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Bird transport isolation from PR 35, rebuild PR 35 as a prompt-template-only change, and address the validated implementation-review feedback.

**Architecture:** Reconstruct the Bird transport work on a clean branch rooted at `origin/main`, merge that PR first, then rebuild `feature/prompt-templates-playground` from the updated `main` using its prompt-only tree delta. Keep review fixes scoped to cache-key contracts, prompt UI language, changelog/configuration docs, and the persisted v6 design.

**Tech Stack:** Git/GitHub CLI, TypeScript 7, React 19, Vitest 4, pnpm, oxfmt, oxlint.

---

### Task 1: Reconstruct Bird Transport Work on Main

**Files:**
- Modify: the files changed by commits `2f562ae..1b0208e`
- Worktree: `.worktrees/bird-zero-xurl-main`
- Branch: `codex/bird-zero-xurl-main`

- [ ] **Step 1: Create an isolated worktree from the latest `origin/main`**

Run:

```bash
git fetch origin main
git worktree add .worktrees/bird-zero-xurl-main -b codex/bird-zero-xurl-main origin/main
```

Expected: the worktree is on `codex/bird-zero-xurl-main` with a clean status.

- [ ] **Step 2: Verify the main baseline**

Run:

```bash
pnpm run check
pnpm test
```

Expected: checks and the complete test suite pass. Production-server tests may require running outside the sandbox because they bind `127.0.0.1`.

- [ ] **Step 3: Replay only PR 40 commits**

Run:

```bash
git cherry-pick 2f562ae^..1b0208e
```

Expected: exactly the 33 commits after PR 40's original base `ca12f7d` are replayed. Resolve digest conflicts in favor of the already-reviewed PR 39 reliability behavior while preserving Bird-only transport selection and its tests.

- [ ] **Step 4: Verify the reconstructed tree**

Run:

```bash
pnpm run check
pnpm test
pnpm run build
git diff --check origin/main...HEAD
```

Expected: all commands pass and the diff contains Bird transport work only, with no prompt-template routes or Config prompt panel.

- [ ] **Step 5: Push and open a replacement PR to main**

Run:

```bash
git push -u origin codex/bird-zero-xurl-main
gh pr create --repo friendfish/birdclaw --base main --head codex/bird-zero-xurl-main --title "fix: prevent xurl access in Bird mode" --body $'## Summary\n\n- make live read transport selection honor Bird mode without passive xurl access\n- validate explicit transport modes before storage or network side effects\n- preserve account and request-state semantics across timeline, mentions, DMs, profile, and scheduled sync paths\n\n## Verification\n\n- pnpm run check\n- pnpm test\n- pnpm run build\n\nReplaces the changes previously merged into feature/prompt-templates-playground by PR #40; this PR targets main directly.'
```

Expected: an open PR targeting `main`. Merge it only after GitHub reports it mergeable and local verification is recorded.

### Task 2: Rebuild PR 35 on Updated Main

**Files:**
- Preserve: prompt templates, prompt-aware result caches, Playground routes, Config prompt UI, and their tests
- Exclude: all Bird transport files already merged through Task 1
- Branch: `feature/prompt-templates-playground`

- [ ] **Step 1: Save the current PR 35 prompt tree and fetch updated main**

Run:

```bash
git tag codex/pr35-pre-rewrite d92dfe5
git fetch origin main feature/prompt-templates-playground
```

Expected: `codex/pr35-pre-rewrite` preserves the recoverable pre-rewrite head.

- [ ] **Step 2: Build a clean prompt-only commit from updated main**

Create a temporary clean branch from `origin/main`. Apply only the net files and hunks attributable to prompt templates/Playground from `codex/pr35-pre-rewrite`; do not reintroduce #39 or #40 changes already on main. Include this implementation plan and the v6 design spec.

Expected: `git diff --stat origin/main...HEAD` contains prompt-template and Playground scope only.

- [ ] **Step 3: Verify the prompt-only baseline before review fixes**

Run:

```bash
pnpm run check
pnpm test
pnpm run build
```

Expected: all commands pass.

### Task 3: Fix Cache-Key Review Findings with TDD

**Files:**
- Modify: `src/lib/prompt-cache-keys.test.ts`
- Modify: `src/lib/search-discussion.ts`

- [ ] **Step 1: Replace the ineffective generation-key assertion**

Add a test that calls `periodDigestGenerationKey` with runtime objects carrying different extra `promptHash` values and asserts exact equality:

```ts
const withPromptA = periodDigestGenerationKey({
	...periodOptions,
	promptHash: "prompt-a",
} as PeriodDigestOptions);
const withPromptB = periodDigestGenerationKey({
	...periodOptions,
	promptHash: "prompt-b",
} as PeriodDigestOptions);
expect(withPromptA).toBe(withPromptB);
```

- [ ] **Step 2: Add a failing search cache-version assertion**

Add:

```ts
expect(
	searchDiscussionTest.cacheKey(searchContext, searchOptions, "prompt-a"),
).toMatch(/^search-discussion:v2:/);
```

Run:

```bash
pnpm vitest run src/lib/prompt-cache-keys.test.ts
```

Expected: FAIL because the implementation still emits `search-discussion:v1`.

- [ ] **Step 3: Bump the search discussion result-cache namespace**

Change only the cache prefix:

```ts
"search-discussion:v2"
```

Run the focused test again. Expected: PASS.

### Task 4: Make Prompt UI and Playground Errors Consistent

**Files:**
- Modify: `src/routes/config.tsx`
- Modify: `src/lib/period-digest.ts`
- Modify: `src/lib/profile-analysis.ts`
- Modify: `src/lib/search-discussion.ts`
- Test: existing prompt route/library tests

- [ ] **Step 1: Add or update assertions for English prompt-specific messages**

Cover the user-visible empty-local-data errors and prompt panel labels without changing the existing Chinese Analyse page outside this feature.

- [ ] **Step 2: Run focused tests and confirm they fail on current Chinese strings**

Run:

```bash
pnpm vitest run src/lib/period-digest.test.ts src/lib/profile-analysis.test.ts src/lib/search-discussion.test.ts src/routes/api/prompt-templates.test.ts
```

Expected: the new string assertions fail.

- [ ] **Step 3: Translate only prompt-feature strings**

Use `Advanced mode`, `Running...`, an English cache-cost warning, and English local-data-empty errors. Leave the surrounding pre-existing Chinese Analyse UI unchanged.

- [ ] **Step 4: Re-run focused tests**

Expected: PASS.

### Task 5: Add Release and Configuration Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/configuration.md`
- Create: `docs/superpowers/specs/2026-07-28-prompt-templates-playground-design.md`

- [ ] **Step 1: Add the unreleased feature entry**

Document editable prompt templates and isolated Playground execution under `0.11.1 - Unreleased` / `Added`.

- [ ] **Step 2: Document prompt storage and behavior**

Add `prompts/` to the storage tree and document:

- fixed feature-to-file mapping;
- schema and system/requirements markers;
- missing file means built-in defaults;
- reset deletes the file;
- corrupt templates are surfaced and require confirmation before overwrite;
- atomic same-directory rename on save;
- prompt changes alter cache identity and may trigger paid AI generation;
- Playground uses local data and bypasses persistence/live X reads;
- the five internal prompt endpoints.

- [ ] **Step 3: Persist the approved v6 design**

Move the authoritative implementation design from the PR description into the spec file, preserving cache, protocol, isolation, storage, error, and testing decisions.

- [ ] **Step 4: Check docs for placeholders and contradictions**

Run:

```bash
rg -n 'TBD|TODO|暂不包含任何代码改动|当前只有一个空提交' docs/superpowers/specs/2026-07-28-prompt-templates-playground-design.md docs/configuration.md CHANGELOG.md
```

Expected: no matches.

### Task 6: Rewrite PR Metadata and Complete Verification

**Files:**
- GitHub PR 35 title/body

- [ ] **Step 1: Run fresh verification**

Run:

```bash
pnpm run check
pnpm test
pnpm run build
git diff --check origin/main...HEAD
```

Expected: all commands pass.

- [ ] **Step 2: Force-push the rebuilt PR branch safely**

Run:

```bash
git push --force-with-lease origin HEAD:feature/prompt-templates-playground
```

Expected: PR 35 updates to the clean prompt-only history without overwriting an unexpected remote head.

- [ ] **Step 3: Rewrite title and description**

Use an implementation title such as `feat: add editable prompt templates and isolated playgrounds`. The body must summarize shipped behavior, cache/cost semantics, storage, isolation, test evidence, and link the persisted design instead of claiming the PR has no code.

- [ ] **Step 4: Confirm GitHub state**

Read back PR 35 and confirm it is open, mergeable, clean, targets `main`, and no longer contains Bird transport-only files in its net diff.
