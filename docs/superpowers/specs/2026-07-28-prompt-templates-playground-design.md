# Editable Prompt Templates and Isolated Playgrounds

Date: 2026-07-28
Status: v6 approved design, updated to describe the implemented PR 35 behavior

## Goal

Make the effective user-controlled prompt text visible and editable for Today,
Analyse, and Discuss, while preserving application-owned output protocols. Let
users run unsaved drafts against real local data without changing production
state.

The affected analysis modules are:

- `src/lib/period-digest.ts`
- `src/lib/profile-analysis.ts`
- `src/lib/search-discussion.ts`

## User Experience

Config has a Prompts tab with one selector for each feature. The normal editor
shows editable system and requirements text. Advanced mode also shows the
dynamic header and locked protocol/dataset placeholders so the request shape is
visible without making machine contracts editable.

Save activates a custom template. Restore default deletes it. If an existing
file cannot be parsed, Config shows built-in defaults and the parse error;
overwriting the original file requires explicit confirmation.

The Playground uses the unsaved editor draft. Today selects a period and content
source, Analyse selects a locally indexed handle, and Discuss accepts a local
query. Empty local datasets produce an explicit error before an AI request.
Today and Discuss stream Markdown. Analyse is non-streaming and displays the
completed result at once. Every result reports whether structured output parsed
or the fallback path was used.

## Storage Contract

Templates have a fixed path under the Birdclaw root:

| Feature | Relative path |
| --- | --- |
| Today | `prompts/period-digest.md` |
| Analyse | `prompts/profile-analysis.md` |
| Discuss | `prompts/search-discussion.md` |

The file format is a strict, versioned Markdown envelope:

```markdown
<!-- birdclaw-prompt-schema: 1 -->

<!-- birdclaw-prompt-system -->
<editable system text>

<!-- birdclaw-prompt-requirements -->
<editable requirements text>
```

Both markers must occur exactly once and in order. Empty sections, unknown
schema lines, and marker strings embedded in editable content are rejected. A
missing file selects built-in defaults. Reset removes the file instead of
encoding a special default value.

Saving creates `prompts/` when absent, writes a uniquely named temporary file in
that directory, and renames it over the destination. Same-directory rename
keeps concurrent readers on a complete old or new version. A failed temporary
write is cleaned up.

## Prompt Composition

Editable text controls persona, emphasis, prose style, and human-facing report
requirements. Citation rules, the Markdown/JSON delimiter, JSON shape, source
ID requirements, and feature-specific language rules remain locked in code.

`materializeEffectivePrompt(editable, protocol)` is the single composition
function for both production templates and Playground drafts. It appends the
locked system and requirements protocol, then computes a SHA-256 `promptHash`
over the complete materialized `system` and `requirements` strings.

Hashing the complete prompt is required. A future protocol or JSON-shape change
must invalidate old results even when the editable file did not change.
Template source metadata such as `isCustom` is excluded so identical effective
content shares a cache identity.

The three prompt builders retain their feature-specific argument shapes. In
particular, period digest accepts an explicit `undefined` options value before
the required effective prompt, search discussion needs no artificial options
parameter, and profile analysis retains its required options parameter. This
avoids an invalid TypeScript signature with a required parameter after an
optional one.

## Cache and Generation Identity

Generated results depend on both local context and the effective prompt. These
keys include `promptHash`:

- period digest content cache;
- period digest latest-result cache, including metadata polling;
- profile analysis result cache;
- search discussion result cache (`search-discussion:v2`).

Profile analysis keeps `context.hash` as the final key segment because metadata
history lookup scans by that suffix. Old- and new-prompt results for one context
can both appear in history; they represent real separate generations.

Context collection caches do not include `promptHash`; raw local data is prompt
independent. `periodDigestGenerationKey`, the period-digest active registry, and
the profile active-analysis registry also do not include it. This deliberately
keeps an in-progress run visible if configuration changes midway through the
request. Its result uses the prompt hash captured at start; a subsequent poll
with a changed prompt may start another paid generation. Config warns about
that tradeoff.

Cached result payloads and stream contracts require
`parseStatus: "structured" | "fallback"`. Missing status is not guessed because
an old row may have been produced by fallback. Prompt-aware keys naturally stop
new code from selecting old-format result rows.

## Playground Isolation

Playground endpoints are separate from production analysis routes and do not
import active-generation registry modules. All accept bounded, schema-validated
JSON and pass through the local-web sensitive-request guard.

| Method and path | Execution |
| --- | --- |
| `POST /api/prompt-playground/period-digest` | NDJSON stream |
| `POST /api/prompt-playground/profile-analysis` | JSON response |
| `POST /api/prompt-playground/search-discussion` | NDJSON stream |

Every draft goes through `materializeEffectivePrompt`; raw editable text can
never bypass the locked protocol. Playground result types contain Markdown,
the structured feature result, required `parseStatus`, and `generatedAt`. They
do not pretend to be production results with `cached` or `updatedAt` fields.

The isolation rules are hard requirements:

- no result-cache reads or writes;
- no writes to business tables;
- no active-generation registration;
- no live Bird or xurl request;
- no profile backfill or avatar prefetch;
- no automatic backup commit;
- no reuse of a cached production result instead of a real AI draft call.

Today sets `liveSync: false` and directly collects local period context. Analyse
uses a local-only context collector and never hydrates missing data. Discuss
forces local mode and disables avatar prefetch. Its `Live search` prompt line is
therefore `not run`, a known fidelity difference from production automatic or
explicit live search.

Cancellation propagates through request signals. Today and Discuss turn stream
errors into terminal NDJSON events; Analyse returns the normal guarded JSON
error response.

## Template API

The template paths use explicit request shapes:

- `GET /api/prompt-templates?feature=...` reads effective editable state and
  exposes the locked protocol preview.
- `POST /api/prompt-templates` requires `feature`, `system`, and `requirements`
  and saves a custom file.
- `POST /api/prompt-templates/reset` requires only `feature` and deletes the
  custom file.

Reset is not inferred from missing save fields. This prevents an incomplete
client request from deleting user content.

## Verification Requirements

Coverage must demonstrate:

- default, valid custom, corrupt, first-save, atomic-save, reset, and reserved
  marker behavior;
- production and Playground composition share the same locked protocol;
- protocol-only changes affect `promptHash`, while source metadata does not;
- result keys change with prompts and active generation identity does not;
- `parseStatus` is required by caches and every response/event schema;
- each Playground calls AI with local data while cache, database, transport,
  prefetch, backup, and active-registry state remain unchanged;
- empty local contexts fail before AI;
- full formatting, lint, type checks, unit tests, and production build pass.

## Non-goals and Follow-ups

This change does not add prompt provenance or `parseStatus` to digest archive
files; that belongs to issue 36. It does not add `prompts/` to portable backups;
that belongs to issue 37. It does not unify the existing feature-specific
language normalization rules, add a real-data prompt preview endpoint, or cache
template reads by mtime.
