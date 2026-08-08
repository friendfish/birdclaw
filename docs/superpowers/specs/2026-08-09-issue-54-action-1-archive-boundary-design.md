# Issue #54 Action 1: Archive Request Boundary Design

## Context

The digest archive routes currently turn missing or unrecognized query values
into valid defaults. This makes malformed requests appear valid. The archive
entry route also passes its unvalidated `date` value into
`resolveDigestArchivePaths`, where `path.join` can resolve traversal segments
outside the configured archive directory.

This change delivers only action 1 from issue #54. Archive schema validation,
read-error classification, metadata consistency checks, launchd cancellation,
fault-injection coverage, and structural refactoring remain separate actions.

## Goals

- Reject explicitly invalid archive periods and content sources with HTTP 400.
- Preserve the existing defaults when period or content source is omitted.
- Require the archive entry date to be a real calendar date in `YYYY-MM-DD`
  form.
- Prevent archive path construction from escaping the configured archive
  directory.
- Keep both archive routes on one request-validation contract.
- Add regression coverage before changing production behavior.

## Non-Goals

- Do not change successful response payloads.
- Do not change the normal `200` response with `result: null` for a missing
  archive entry.
- Do not change archive file names, schemas, or persisted contents.
- Do not classify corrupt archive data or non-ENOENT read failures; that is
  issue #54 action 2.
- Do not verify archive metadata against the request; that is action 3.
- Do not add symlink-aware containment. The documented threat model requires
  lexical containment; local-user symlink attacks remain a possible later
  hardening step.

## Chosen Approach

Add a small shared request-validation module used by both archive API routes.
It will expose focused parsers for archive period, content source, and entry
date. The parsers throw request-validation errors with stable, non-sensitive
messages; each route maps those errors to its existing JSON error shape with
HTTP 400.

The shared rules are:

- omitted `period` defaults to `yesterday`;
- `period=yesterday` and `period=week` are accepted;
- `period=today`, `period=24h`, and any other explicit value return HTTP 400;
- omitted `contentSource` defaults to `all`;
- `contentSource=all`, `for_you`, and `following` are accepted;
- any other explicit content source returns HTTP 400;
- archive entry `date` is required and must identify a real date using exactly
  a four-digit year from 0001 through 9999, a two-digit month, and a two-digit
  day.

The dates-list route validates only `period`. The archive-entry route validates
all three parameters before resolving the archive directory or reading a file.

## Path Containment

`resolveDigestArchivePaths` remains the single path-construction boundary. It
will resolve the configured archive root and the requested date directory,
then inspect `path.relative(root, candidate)`. It rejects the candidate when
the relative path is `..`, starts with `..${path.sep}`, or is absolute.

The file basename continues to come only from the typed period and content
source values. Valid callers therefore receive the same `.md` and `.json`
paths as before, while direct or future callers cannot use traversal segments
to escape the archive root.

## Error Handling

Invalid public request parameters return HTTP 400 with `{ ok: false, error }`.
The existing specific explanation for `today` and `24h` remains available,
because those are valid current views but do not have historical archives.
Other invalid values receive parameter-specific messages.

Containment failures from non-route callers throw before any filesystem read or
write. Routes should never reach this error after successful date validation;
it is defense in depth rather than a second public validation contract.

## Test Strategy

Use a red-green test sequence covering:

- both routes preserving the omitted-period default;
- the entry route preserving the omitted-content-source default;
- both routes returning HTTP 400 for an unknown period;
- the existing HTTP 400 behavior for `today` and `24h`;
- the entry route returning HTTP 400 for an unknown content source;
- missing, malformed, normalized-but-not-exact, and impossible dates returning
  HTTP 400;
- valid regular and leap-day dates reaching the archive reader;
- traversal attempts returning HTTP 400 without reading outside the archive;
- `resolveDigestArchivePaths` rejecting parent and absolute escapes, including
  a sibling directory whose name shares the archive root prefix;
- valid path construction remaining byte-for-byte compatible.

After targeted tests pass, run formatting and lint checks, type checking, the
full test suite, and the production build.

## Delivery

Implement this as the first bounded issue #54 change. The commit or pull request
will reference issue #54 and report only action 1 as complete; the umbrella
issue remains open for the later actions.
