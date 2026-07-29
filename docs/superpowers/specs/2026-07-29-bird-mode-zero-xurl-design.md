# Bird Mode Must Never Invoke xurl

Date: 2026-07-29

## Problem

Birdclaw supports `bird`, `xurl`, and `auto` live transports. Several orchestration paths currently bypass the selected mode by hard-coding `xurl` or by probing xurl as part of passive page loading. As a result, a user configured for Bird can still start an xurl subprocess, which may open an authentication window and then fail against the X service.

Confirmed paths include:

- period digest mention and mention-thread refreshes;
- post-digest profile hydration fallback;
- `/api/data-sources` status collection used by `useBirdAvailable`;
- the shared query envelope's xurl status probe;
- account sync mention-thread refreshes;
- CLI defaults that choose xurl without consulting the configured read mode.

The intended invariant is:

> Once an operation resolves to `bird`, it must not execute, probe, or fall back to xurl anywhere in that operation's call graph.

`auto` may still use xurl. An explicit `xurl` selection must continue to work even when Bird is the configured default.

## Transport Resolution

Introduce one shared policy module for live read mode. The public configuration
resolution order is:

1. an explicit operation argument (`bird`, `auto`, or `xurl`);
2. `BIRDCLAW_LIVE_DATA_SOURCE`;
3. `live.dataSource` in Birdclaw configuration;
4. the legacy `BIRDCLAW_MENTIONS_DATA_SOURCE` alias;
5. the legacy `mentions.dataSource` alias;
6. the named capability default for callers that have no configured live source.

The policy returns only `bird`, `auto`, or `xurl`. `live.dataSource` is the
documented global live-read preference. `mentions.birdCommand` remains scoped to
the Bird executable. The legacy `mentions.dataSource` key and environment
variable remain accepted so existing installations do not break.

The local-only legacy value `birdclaw` means no global live transport was
selected. Mention export continues to interpret it as local-only. Other live
features use a named capability default that preserves their behavior from
before this change. The policy module owns those defaults through dedicated
resolvers; callers must not pass `"xurl"`, `"auto"`, or `"bird"` as fallback
literals.

Write actions keep using the existing `actions.transport` resolver. An explicit Bird write must not fall through to xurl; `auto` retains its existing fallback behavior.

Callers must resolve mode once at their orchestration boundary and pass that value through every sub-step. Leaf transport adapters must not independently replace `bird` with `xurl`.

## Behavior Changes

### Period Digests

Timeline, mentions, and mention-thread refreshes use the same resolved mode. In Bird mode:

- home timeline uses Bird;
- mentions use Bird;
- mention threads use Bird;
- progress text reports the actual selected/source transport and does not claim xurl unconditionally.

For `auto`, existing xurl-capable fallback behavior remains allowed. If a lower-level API does not accept `auto`, the orchestrator may preserve the existing xurl choice for `auto`; it must never do so for `bird`.

### Profile Hydration

Profile resolution continues to try Bird first. Its default xurl fallback is derived from the resolved mode:

- `bird`: fallback disabled;
- `auto` or `xurl`: fallback enabled;
- an explicit `xurlFallback` option still overrides the default because it is an explicit caller choice.

The profile hydration API therefore cannot invoke xurl merely because Bird returned no profile. The older bulk `hydrateProfilesFromX` path also skips xurl status checks when the configured read mode is Bird and performs only its Bird-compatible account correction.

### Passive Status Checks

Passive UI loading must not probe an unused transport.

- `getLiveDataSourcesEffect` still reports an xurl source row in Bird mode, but marks it unavailable/disabled by selection without running `xurl version`, `xurl auth status`, or an authenticated lookup.
- `getQueryEnvelopeEffect` returns a local/disabled transport status in Bird mode without executing xurl.
- An explicit xurl or auto operation may still perform the current status checks.

This keeps response schemas stable while removing the subprocess side effect.

### Jobs and CLI Defaults

Scheduled/background orchestration and CLI commands without an explicit mode use the shared resolver. Hard-coded xurl remains valid only when:

- the command or API explicitly selected xurl;
- the resolved mode is `auto` and xurl is an allowed fallback;
- code is inside the xurl adapter itself;
- a test fixture or documentation example intentionally describes xurl.

Features that cannot operate through Bird must return a clear unsupported/disabled result in Bird mode instead of silently launching xurl.

### Review Follow-up Boundaries

The following boundaries close the configuration and explicit-override gaps
found during review:

- `sync mention-threads` must not define a Commander mode default. An omitted
  mode is resolved by the shared policy, then narrowed to the Bird/xurl modes
  supported by the command.
- Discuss stores an omitted mode as `configured` UI state and leaves the API
  query parameter absent. The server then resolves the current live-read
  preference. Selecting Auto, Bird, xurl, or Local remains an explicit override.
- remote block synchronization is a read operation and therefore uses the
  live-read policy, not `actions.transport`. Bird returns the existing successful
  silent-skip result without probing xurl. A command-level mode can explicitly
  select xurl.
- compose post, reply, and DM writes remain governed by `actions.transport`.
  They are xurl-only today, so Bird rejects them before staging or transport
  work. Documentation and errors must state that limitation; the fix must not
  restore an implicit xurl call.
- xurl-only profile reply inspection accepts an explicit mode. Configured Bird
  rejects before xurl, while an explicit xurl selection remains available.
- DM and Whois profile enrichment expose both positive and negative xurl
  fallback flags. An explicit positive flag may override configured Bird; an
  omitted flag follows the shared policy.

Low-level live adapters that historically defaulted to Auto must consult the
named policy resolver when their caller omits a mode. This prevents a new caller
from accidentally bypassing configured Bird.

## Error Handling

Bird failures in Bird mode are surfaced or converted to the existing partial/local-data result at the same layer that currently handles transport failure. They must not cause a hidden xurl retry.

Skipped passive probes return stable status objects with an explanation such as `xurl disabled by bird transport selection`. They are not treated as subprocess errors.

Disabled status must not report xurl as uninstalled without probing it. The
installation field is omitted when selection policy, rather than an executable
check, disabled the transport.

Shared policy errors use transport-neutral wording because the same resolver is
used by CLI commands, HTTP handlers, scheduled jobs, and web sync.

Explicit xurl failures and auto fallback failures retain their current error handling.

## Testing

Tests will use transport/subprocess spies and fail before implementation by observing xurl calls. Coverage must include:

- period digest refresh with `liveSyncMode: "bird"` across timeline, mentions, and threads;
- profile handle hydration when Bird misses or errors;
- data-source status collection in configured Bird mode;
- shared query envelope construction in configured Bird mode;
- account sync mention-thread execution in Bird mode;
- CLI/API default-mode resolution from Bird configuration;
- control cases proving `auto` may still reach xurl and explicit `xurl` still reaches xurl.
- legacy and new configuration precedence, including `live.dataSource` aliases;
- omitted `sync mention-threads` and Discuss modes following configuration;
- block sync using live-read policy independently of write transport;
- explicit xurl escape hatches for profile replies and profile enrichment;
- xurl-disabled status with unknown installation state.

After behavioral tests pass, a full-directory static audit will classify every remaining production `xurl` literal. No automatic or Bird-mode orchestration path may retain an unconditional xurl mode or fallback.

## Scope

This change does not remove xurl support, rename xurl-compatible payload types,
rewrite stored source labels, or remove the legacy `mentions.dataSource` key. It
adds `live.dataSource` as the accurately named public setting and retains the old
key as an alias. It removes implicit xurl execution when the resolved transport
is Bird and centralizes default selection to prevent recurrence.
