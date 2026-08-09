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
- Apply the same real-date rule to archive dates restored from route search.
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

Add a neutral calendar-date module that owns the non-throwing real-date
predicate used by route-search normalization, request parsing, directory
enumeration, and path construction. A separate request-validation module
exposes focused parsers for archive period, content source, and entry date. The
parsers throw a dedicated request-validation error with stable, non-sensitive
messages; a shared error-classification function lets each route map only that
error to its existing JSON error shape with HTTP 400.

The shared rules are:

- omitted `period` defaults to `yesterday`;
- an explicitly present but empty `period` is invalid rather than omitted;
- `period=yesterday` and `period=week` are accepted;
- `period=today`, `period=24h`, and any other explicit value return HTTP 400;
- omitted `contentSource` defaults to `all`;
- an explicitly present but empty `contentSource` is invalid rather than
  omitted;
- `contentSource=all`, `for_you`, and `following` are accepted;
- any other explicit content source returns HTTP 400;
- archive entry `date` is required and must identify a real date using exactly
  a four-digit year from 0001 through 9999, a two-digit month, and a two-digit
  day.

Route-search normalization uses the same predicate. A malformed or impossible
`archiveDate` becomes the existing empty selection instead of reaching the API
and turning the archive view into a hard fetch error.

The dates-list route validates only `period`. The archive-entry route validates
all three parameters before resolving the archive directory or reading a file.

## Path Containment

`resolveDigestArchivePaths` remains the single path-construction boundary. It
will resolve the configured archive root and the requested date directory,
then inspect `path.relative(root, candidate)`. It rejects the candidate when
the run date is not itself a real `YYYY-MM-DD` date (including empty or `.`),
the relative path is `..`, starts with `..${path.sep}`, or is absolute.
Actual parent or absolute escapes keep the containment-specific error, while a
contained but invalid run date receives a separate calendar-date error.

The file basename continues to come only from the typed period and content
source values. Valid callers therefore receive the same `.md` and `.json`
paths as before, while direct or future callers cannot use traversal segments
to escape the archive root.

Archive directory enumeration uses the same real-date predicate and ignores
malformed or impossible legacy directory names instead of failing the entire
dates response.

## Error Handling

Invalid public request parameters return HTTP 400 with `{ ok: false, error }`.
The existing specific explanation for `today` and `24h` remains available,
because those are valid current views but do not have historical archives.
Other invalid values receive parameter-specific messages.

Only the dedicated archive request-validation error maps to HTTP 400. The
shared classifier rethrows URL construction failures and unexpected parser
defects so they continue through the route's existing server-error path and are
not echoed to the client as request messages.

Containment failures from non-route callers throw before any filesystem read or
write. Scheduled jobs validate the formatted run date once through the Effect
error channel before acquiring a lock or entering content-source retries, so an
invalid clock override fails immediately rather than sleeping through retries.
The path constructor repeats the check inside the write workflow as defense in
depth. Routes should never reach this error after successful date validation;
it is not a second public validation contract.

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
- direct parser coverage for accepted content sources, years 0001 and 9999,
  leap-century behavior, current-view messages, and explicit empty values;
- route-search normalization rejecting impossible dates;
- unexpected parser failures not being classified as HTTP 400;
- traversal attempts returning HTTP 400 without reading outside the archive;
- `resolveDigestArchivePaths` rejecting parent and absolute escapes, including
  a sibling directory whose name shares the archive root prefix;
- valid path construction remaining byte-for-byte compatible;
- empty, dot, and non-date run directories being rejected;
- malformed or impossible archive directories being ignored during listing;
- a scheduled invalid run date failing before retries with a date-specific
  message;
- boundary years being formatted with exactly four digits;
- the shared request-error classifier returning dedicated messages and
  rethrowing unexpected failures.

After targeted tests pass, run formatting and lint checks, type checking, the
full test suite, and the production build.

## Delivery

Implement this as the first bounded issue #54 change. The commit or pull request
will reference issue #54 and report only action 1 as complete; the umbrella
issue remains open for the later actions.
