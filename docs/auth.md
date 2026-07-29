---
title: Sign in
description: "Connect birdclaw to X through xurl or bird, verify each tool, and choose the live write transport."
---

# Sign in

birdclaw keeps its database local. Archive import needs no X credentials. Live reads and writes are delegated to external CLIs:

- [`xurl`](https://github.com/xdevplatform/xurl) is the recommended setup for new users and uses the official X API with your own developer app.
- Existing private `bird` installations remain supported for cookie-backed workflows and compatibility fallback.

Install xurl for a new live-transport setup. `live.dataSource` is the global
choice for live reads and syncs; supported commands can override it with
`--mode`. `auth use` persists `actions.transport` for compose writes (post,
reply, and DM compose) and moderation writes that use the actions policy.

On a fresh Birdclaw database, import your X archive before the first live sync. Archive import establishes your real account identity; `init --demo` creates only synthetic sample data. The current auth commands verify transports but do not bind a new database to the authenticated X account.

## Set up xurl

Install xurl, register an X developer app, then start OAuth2 authentication. Homebrew is available on macOS; npm and the upstream install script work on macOS and Linux:

```text
# macOS
brew install --cask xdevplatform/tap/xurl

# macOS or Linux
npm install -g @xdevplatform/xurl

xurl auth oauth2 --app my-app
xurl whoami
```

Alternatively, use xurl's [no-sudo install script](https://github.com/xdevplatform/xurl#installation). Register `my-app` first by following the [xurl authentication guide](https://github.com/xdevplatform/xurl#authentication). The redirect URI configured in the X developer portal must match xurl's configured URI. Treat the client secret as a secret; avoid entering it in shared shell history or exposing it in process listings.

## Existing bird installations

Birdclaw preserves compatibility with existing private bird installations, but bird is not a public setup path for new users. If bird is already installed and authenticated, verify the detected account:

```text
bird whoami
```

Existing bird configurations continue to provide cookie-backed fallback for
supported reads and moderation writes. Post, reply, and DM compose remain
xurl-only writes.

## Verify xurl in birdclaw

```text
birdclaw auth status --json
```

`auth status` runs a coarse xurl status probe. It does not probe bird, prove that a specific X API request will succeed, or choose a transport for every command.

- `installed` appears only when Birdclaw actually probes xurl; it reports whether the executable exists. A deliberately disabled xurl transport omits this field rather than claiming xurl is uninstalled.
- `availableTransport` is `xurl` when `xurl auth status` succeeds without a known unauthenticated message; otherwise it is `local`.
- `statusText` explains the detected state.
- `rawStatus` contains xurl's status output when available.

Use `xurl whoami` as the end-to-end authentication check. Run `xurl auth status` for detailed app/token state. Existing private bird users can run `bird whoami` to verify bird independently.

## Choose write transport

Persist the preferred transport for compose writes (post, reply, and DM
compose) and moderation writes that use the actions policy:

```text
birdclaw auth use auto
birdclaw auth use bird
birdclaw auth use xurl
```

`auto` tries Bird first for supported moderation writes, then xurl. A
command-level `--transport` flag overrides the saved value, and
`BIRDCLAW_ACTIONS_TRANSPORT` overrides it for one process. Bird has no post,
reply, or DM compose implementation, so those commands explicitly reject
`actions.transport: "bird"`; use `auto` or `xurl` for xurl writes.
DM request mutations (`dms accept`, `dms reject`, and `dms block`) use Bird
directly and do not use `actions.transport`.

Live reads and syncs do not use this saved write setting. Set
`live.dataSource` (or `BIRDCLAW_LIVE_DATA_SOURCE`) globally, or select a source
with the command's `--mode` flag:

```text
birdclaw sync timeline --mode auto
birdclaw sync mentions --mode bird
birdclaw sync likes --mode xurl
```

Select an existing Birdclaw account per operation with its username or stored ID:

```text
birdclaw sync timeline --account steipete --mode xurl
birdclaw import hydrate-profiles --account @steipete
birdclaw profiles replies @someone --account steipete
```

With xurl, Birdclaw routes that invocation to the matching named OAuth2 account. With Bird, Birdclaw cannot switch cookie jars itself and instead refuses the operation when `bird whoami` does not match. Put `{"accounts":{"default":"steipete"}}` in `config.json` to omit the repeated flag. This selects an existing row only; it does not change the database default or persist credential identity.

Supported modes differ by command; use `birdclaw sync <command> --help`.

## Security

- xurl stores developer-app credentials and OAuth tokens under `~/.xurl`.
- bird uses browser session cookies. Treat `auth_token` and `ct0` as full account credentials.
- Use archive-only mode when live access is unnecessary.
- Set `BIRDCLAW_DISABLE_LIVE_WRITES=1` for development or dry runs.

For multiple Birdclaw accounts, use `--account <username>` or a stored account ID on commands that support it. See [Configuration](configuration.md#multi-account).
