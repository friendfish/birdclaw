# Issue #53: Empty Digest Integrity Design

## Context

The scheduled 24h batch can receive an HTTP 200 streaming response with no
visible model output. The current stream reader treats EOF as success, the
period-digest fallback turns the empty text into a schema-valid placeholder,
and the orchestrator publishes it as the new stable current result. That allows
an empty result to replace a previously valid latest-success value.

The fix must preserve the existing batch architecture: sources are generated
sequentially from frozen contexts, each source retries independently, and a
failure for one source must not stop later sources.

## Goals

- Treat empty and whitespace-only streamed visible output as generation failure.
- Make reasoning-only and empty `finish_reason=length` responses observable and
  retryable.
- Reject empty Markdown and placeholder-only digests before generation-cache
  writes, publication, and current-store writes.
- Preserve the previous current value and `generatedAt` when replacement
  generation fails.
- Keep other content sources independent within the same batch.
- Persist non-sensitive model diagnostics in the period-digest run audit.
- Recover an invalid current value from the newest valid legacy latest cache
  when possible; otherwise let the existing freshness path regenerate it.
- Keep metadata and page state consistent with the presence of displayable
  content.

## Non-Goals

- Do not change prompts, model settings, output token budgets, or source order.
- Do not persist raw SSE frames, prompts, model output, credentials, or other
  sensitive request data as diagnostics.
- Do not make fallback parsing itself an error. A fallback with non-empty,
  displayable Markdown remains valid.
- Do not change archived Yesterday or Week behavior.

## Chosen Approach

Use layered validation at the transport, digest, orchestration, and storage
boundaries. A transport-only fix catches the observed empty stream but cannot
protect against future generators returning an invalid result. A store-only fix
protects latest-success but happens too late to enter the generation retry loop
and still allows invalid generation caches. Layered validation makes the same
displayability rule authoritative at every publication boundary.

## Stream Completion and Diagnostics

`openai-response-runtime` will track these non-sensitive fields while consuming
Responses API and Chat Completions streams:

- provider response ID, when supplied;
- finish reason, including Chat Completions `finish_reason` and Responses API
  incomplete reasons;
- visible output character length;
- reasoning output character length.

Chat Completions reasoning deltas are counted but never appended to visible
output. The runtime will also count supported Responses API reasoning delta
events without exposing their content.

At EOF, the stream reader will construct diagnostics before returning or
throwing. Explicit provider errors continue to fail. If visible output is empty
after trimming, the reader throws a typed error carrying the diagnostics. This
covers an empty stream, whitespace-only output, reasoning-only output, and a
`finish_reason=length` completion with no visible text.

The error message will contain only the non-sensitive diagnostic values so the
existing sanitized run-state error remains useful. Structured diagnostics will
also be extracted by the orchestrator and persisted in the final source state
written to `logs/period-digest.jsonl`.

Successful generation results will carry the same diagnostics. The
orchestrator will copy them into the completed source state, so successful and
failed attempts can be distinguished without retaining raw model output.

The non-stream analysis path will reject whitespace-only extracted output for
consistency, while retaining its existing response parsing behavior.

## Digest Displayability Contract

`period-digest` will expose one shared predicate/assertion for displayable
results. A result is displayable only when:

1. `markdown.trim()` is non-empty; and
2. the digest is not a placeholder-only value.

A placeholder-only value has no meaningful title or summary after excluding
the existing language marker form such as `[zh-CN]` and the existing
`No model summary was returned.` sentinel, and has no topics, links, people, or
actions. Source tweet IDs alone do not make a digest displayable.

Non-empty fallback Markdown remains valid even when structured JSON parsing
fails. This preserves the current degradation behavior for useful prose.

The assertion will run:

- before `completeOpenAIStreamEffect` writes exact or legacy latest generation
  caches;
- immediately after each orchestrator `generate` call, inside the retry loop;
- before `publishCurrentPeriodDigest` writes the stable current key;
- when reading current and legacy cache candidates.

Running the orchestrator check inside the retry loop ensures any future or
injected generator returning an invalid result gets the normal retry policy.
The current-store check remains the final defense against bypass callers.

## Publication and Failure Isolation

For each source, an invalid generated result throws before publication. The
orchestrator records the attempt, waits using the existing retry delay, and
retries up to the configured limit. If attempts are exhausted, the source is
marked failed and its previous current row is untouched.

The outer source loop continues unchanged. Following and For You can therefore
publish even when All exhausts its retries. A batch with mixed outcomes is
`degraded`; a batch with no successful source is `failed`.

Publication remains an atomic sync-cache upsert. Validation happens before the
upsert, so no delete, blank write, or generated timestamp update occurs on
failure.

## Current Recovery

Current-row parsing will treat empty Markdown and placeholder-only digest data
as invalid. When metadata cannot read a valid current row, the existing one-time
legacy migration runs.

Legacy migration will distinguish a valid current row from a merely present raw
row. It will preserve a valid stable row, but it may replace an invalid stable
row with the newest valid legacy `period-digest-latest:*` candidate for the same
period and content source. Invalid legacy candidates are skipped using the same
displayability contract.

If no valid legacy candidate exists, metadata returns no result with
`isStale=true`. The existing page freshness request then schedules regeneration.
The invalid raw row remains unreachable and is atomically replaced only after a
valid future generation succeeds.

The affected local All/24h current has already been replaced by a later valid
generation, so implementation does not mutate the user's current database.

## Metadata and UI Consistency

`period-digest-metadata` will only map a current row to `cached: true` after the
displayability contract succeeds. A mocked or future bypass value with empty
Markdown is returned as no result.

The Today page will additionally use non-empty Markdown as the condition for
showing cached/ready status and a generation timestamp. This defensive check
prevents a malformed API response from displaying `Cached` beside
`Waiting for the first tokens...`.

During generation or failure, a previously valid result remains the selected
result and stays visible, matching the existing latest-success behavior.

## Compatibility

- New diagnostics fields are optional in persisted current and run-state
  parsing so existing version 1 rows remain readable.
- Current and legacy cache keys do not change.
- Existing valid fallback results remain readable and publishable.
- The provider response ID is stored only when the provider supplies one; no
  synthetic ID is required for diagnostics.

## Test Strategy

Add failing tests before implementation for:

- HTTP 200 streams with no visible output;
- whitespace-only visible output;
- reasoning-only Chat Completions output;
- `finish_reason=length` with no visible output;
- preserved response ID, finish reason, visible length, and reasoning length;
- non-empty fallback Markdown remaining valid;
- generation-layer rejection before cache writes;
- orchestrator retries for an invalid returned result;
- exhausted retries preserving the previous current value and `generatedAt`;
- later sources publishing after All fails;
- current-store rejection of empty and whitespace-only Markdown;
- current-store rejection of placeholder-only summaries;
- recovery of an invalid current row from the newest valid legacy cache;
- metadata refusing `cached: true` for invalid content;
- the Today page never rendering cached status with the first-token empty state;
- existing content staying visible during generation and after failure.

Run targeted tests through the red-green cycle, then run `pnpm check`, the full
`pnpm test` suite, and `pnpm build` before completion.
