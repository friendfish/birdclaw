# Issue 44 Cleanup Design

## Goal

Close the three independent follow-up gaps tracked by issue #44: restore the
local worktree ignore rule, document the prompt-template parser contract, and
create meaningful branch-coverage headroom without changing the configured 80%
branch threshold.

## Scope

The change will:

- add `.worktrees/` between `.playwright-home-*` and `coverage` in
  `.gitignore`;
- state in `docs/configuration.md` that the schema declaration must be the
  first line, only schema version 1 is supported, and both editable sections
  must contain non-whitespace text;
- add user-visible route tests for the currently untested Data Sources and
  Profile Analyse screens; and
- raise measured global branch coverage from the Node 24.18 baseline of
  80.19% (11710/14602) to at least 81%, while retaining the configured 80%
  threshold as cross-version and future-change headroom.

This change will not alter prompt parsing, route behavior, coverage exclusions,
or coverage thresholds.

## Test Design

### Data Sources

Add a route-component test suite that renders through the repository's real
React Query test wrapper and controls only the HTTP boundary. The suite will
exercise:

- initial loading and successful snapshot rendering;
- healthy, warning, unavailable, and not-installed source states;
- account labels derived from handles, usernames, ids, app names, and default
  account status;
- capability notes plus primary and fallback source chains;
- refresh behavior; and
- request errors, including both `Error` and non-`Error` query failures where
  the test harness can reach them through React Query.

### Profile Analyse

Add a route-component test suite that controls the route search value,
navigation callback, profile-analysis stream hook, and HTTP responses. It will
exercise the major user-visible states instead of testing implementation-only
helpers:

- landing-page metadata loading, empty lists, populated analyzed/following
  lists, account loading, profile selection, and metadata refresh;
- an unanalyzed profile, including the concurrent-task warning and Analyse
  action;
- background analysis and live status presentation;
- saved snapshot selection, snapshot return, Markdown header normalization,
  and profile identity fallback;
- live Markdown and error presentation; and
- language changes and explicit refresh behavior.

Mocks will remain at network, router, and long-running stream boundaries.
Rendered text, button state, navigation inputs, and action calls will be the
primary assertions.

## Coverage Strategy

The Data Sources route currently has 0/54 covered branches and the Profile
Analyse route has 0/184. These are large, reachable, user-facing gaps, so they
provide more durable value than scattering assertions across unrelated utility
files or excluding code from coverage.

Before adding the tests, run coverage with a temporary 81% branch override and
record the expected failure. After the focused tests pass, rerun the same strict
override. The committed Vitest configuration remains at 80%.

## Verification

The implementation is accepted when:

- `git check-ignore .worktrees/example` identifies the new ignore rule;
- the prompt-template documentation names all three parser constraints;
- focused Data Sources and Profile Analyse tests pass;
- global branch coverage is at least 81% under the project's pinned Node
  26.5.0 runtime and does not fall below 81% under the local Node 24 runtime;
- `pnpm run check`, `pnpm test`, and `pnpm run build` pass; and
- `git diff --check` reports no whitespace errors.

