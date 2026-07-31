# PR 35 Third Review Remediation

Date: 2026-07-30
Status: Approved supplement to the v6 prompt-template design

## Goal

Close the remaining third-review findings without broadening PR 35 beyond
editable prompt templates and isolated Playgrounds. The remediation must prevent
stale Playground work from crossing feature boundaries, restore testable UI
boundaries, keep the advanced preview faithful to production prompt assembly,
and make API and runtime contracts explicit.

This document supplements
`docs/superpowers/specs/2026-07-28-prompt-templates-playground-design.md`.
Where the documents overlap, this supplement adds lifecycle and verification
requirements; it does not change the v6 storage, cache, or isolation decisions.

## Review Assessment

| Finding | Assessment | Decision |
| --- | --- | --- |
| P0-3 Playground output crosses feature tabs | Valid, deterministic shared-state bug | Fix and add a behavioral regression test |
| P1-6 advanced preview omits the fixed task instruction | Valid fidelity gap | Give production builders and the preview one shared instruction source |
| P1-7 default prompt sentence order changed | Valid compatibility observation | Document the order change; do not add a complex mid-string insertion format |
| P1-8 reset errors do not match save errors | Valid API inconsistency | Convert filesystem failures into a clear JSON error response |
| P1-9 prompt UI has no behavioral coverage | Valid and now a measurable branch-coverage regression | Extract the panel and test user-visible behavior |
| P1-10 result schemas use loose objects plus forced casts | No current user-visible bug, but a valid contract weakness | Replace the casts with exact client-safe schemas |

## Component Boundary

Move the complete prompt editor and Playground UI out of
`src/routes/config.tsx` into `src/components/PromptTemplatesPanel.tsx`.
`ConfigRoute` remains responsible for loading global configuration, choosing the
top-level Config tab, and passing `aiLanguage` to the prompt panel. The extracted
component owns only:

- prompt feature selection and template loading;
- editable system and requirements drafts;
- save, reset, and corrupt-file confirmation;
- advanced prompt preview;
- feature-specific Playground inputs;
- Playground request lifecycle and rendered output.

This is a focused extraction, not a general Config-page rewrite. AI, language,
and digest-schedule forms remain in `src/routes/config.tsx`.

## Playground Run Lifecycle

The root cause of P0-3 is that every request callback writes to one shared set of
React state while `feature` can change independently. Aborting alone is not a
complete correctness boundary: a response can settle at the same time as the
abort, and an old `finally` block can clear the loading state of a newer run.

The panel therefore owns an active-run record containing a unique identity, the
feature snapshot, and its `AbortController`. A run follows this lifecycle:

1. Starting a run cancels and retires any previous record.
2. Request URLs, bodies, and result parsing use the captured feature snapshot,
   never a later render's `feature` value.
3. Delta, done, error, and non-streaming response handlers update state only
   when their run identity is still active.
4. A feature-tab change retires and aborts the active run before changing the
   selected feature, then clears the prior output and error state.
5. Stop retires and aborts the active run and immediately restores the idle UI.
6. `finally` clears `running` only when it still owns the active identity.
7. Unmount aborts the active controller.

Feature tabs remain usable during a run. Switching is an explicit cancellation
action rather than a disabled interaction, so users do not have to wait for or
manually stop a long model request before inspecting another template.

## Shared Locked Task Instructions

Each production prompt contains one feature-specific fixed instruction between
the dynamic context header and `Requirements:`. Add that instruction to the
shared prompt-template definition alongside the locked protocol. Production
`buildPrompt` functions and `AdvancedPromptPreview` must both read the same
value; the UI must not maintain a second string map.

The instruction participates in `promptHash` because it is locked prompt input.
Changing it in a later release must invalidate results generated under the old
instruction. The materialized effective prompt carries the instruction as an
explicit field so builders remain pure and do not re-read template state.

The editable default and locked protocol segmentation changes the sentence
order of the Today and Discuss system messages and moves citation bullets within
requirements compared with 0.11.0. Reconstructing the old order would require a
new editable format with locked content inserted inside user text. That
complexity is not justified for this release; the compatibility-visible order
change is recorded in the changelog instead.

## Reset Error Contract

`POST /api/prompt-templates/reset` must apply the same filesystem error boundary
as template save. A delete failure returns JSON with `ok: false` and the concrete
error message instead of escaping as an opaque route failure. Invalid request
shape remains a 400 response.

The regression test uses a real filesystem failure by placing a directory at the
fixed template-file path. It does not mock `resetPromptTemplate`, so the test
exercises the actual `rmSync` error and route conversion.

## Playground Result Schemas

The browser-facing contract must validate the complete structured value returned
for Today, Analyse, and Discuss. Move or expose the three Zod result schemas from
a client-safe module that contains no Node filesystem, database, or transport
imports. Feature runtimes and Playground contracts share those schemas.

The NDJSON event schemas are inferred directly from their Zod definitions. They
must not use `z.looseObject({})` for structured results or cast through
`unknown` to claim a stronger TypeScript type than runtime validation provides.

## Behavioral Test Design

Add `src/components/PromptTemplatesPanel.test.tsx` using the repository's
Testing Library and fetch-stubbing patterns. Tests exercise the rendered panel,
not source text. Coverage includes:

- initial template loading and the cache-cost warning;
- corrupt-template warning and declined/accepted overwrite confirmation;
- successful save and restore-default flows plus surfaced API errors;
- advanced preview for all three shared fixed task instructions;
- Today and Discuss NDJSON success, terminal error, malformed/premature stream,
  and Stop behavior;
- Analyse's non-streaming success and failure behavior;
- switching from an in-flight Today run to Analyse aborts the Today signal and
  suppresses late Today delta, done, error, and `finally` state changes;
- loading failures and empty local-profile metadata.

Focused domain and route tests cover shared instruction hashing, production
prompt assembly, exact result-schema rejection, and reset filesystem errors.

## Acceptance Gates

The remediation is complete only when:

- the new feature-switch regression test fails on `dc6af0a` and passes after the
  lifecycle fix;
- every production-code behavior change is introduced after its failing test;
- focused component, prompt-template, prompt-contract, and API tests pass;
- `pnpm run check`, `pnpm test`, `pnpm run build`, and `git diff --check` pass;
- `pnpm coverage` has no metric below configured thresholds and branch coverage
  does not regress relative to `origin/main`;
- PR 35 remains prompt-only and GitHub reports it mergeable and clean.

## Non-goals

This remediation does not split the other Config tabs, add a real paid-model
Playwright scenario, restore 0.11.0 prompt sentence ordering through a new file
format, add prompt provenance to archives, or add prompt files to portable
backups. Existing issues 36 and 37 continue to own archive provenance and backup
support.
