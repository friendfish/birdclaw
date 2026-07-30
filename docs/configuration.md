---
title: Configuration
description: "birdclaw config files, env vars, transport precedence, and multi-account profiles."
---

# Configuration

birdclaw reads configuration from these layers:

1. **Command flags** — for example `--account`, `--mode`, and `--transport`.
2. **Environment variables** — global paths plus feature-specific overrides.
3. **User config** — `~/.birdclaw/config.json`, or the file selected by `BIRDCLAW_CONFIG`.

## Storage root

The default root is `~/.birdclaw`. It holds:

```text
~/.birdclaw/
  birdclaw.sqlite              # canonical local truth
  config.json                  # user config
  prompts/                     # optional editable AI prompt templates
  media/                       # original media cache
  media/thumbs/avatars/        # avatar cache
  audit/                       # JSONL audit logs (e.g. bookmarks-sync.jsonl)
  logs/                        # launchd stdout/stderr
  locks/                       # job lock files
```

Override the root for one process:

```bash
export BIRDCLAW_HOME=/path/to/custom/root
```

The Playwright test home is `.playwright-home` in the repo, which is why CI never touches the production root.

## Config file

`~/.birdclaw/config.json` controls live transport, writes, scheduled jobs, and backup auto-sync.

```json
{
	"accounts": {
		"default": "steipete"
	},
	"actions": {
		"transport": "auto"
	},
	"live": {
		"dataSource": "bird"
	},
	"mentions": {
		"birdCommand": "/Users/steipete/Projects/bird/bird"
	},
	"backup": {
		"repoPath": "/Users/steipete/Projects/backup-birdclaw",
		"remote": "https://github.com/steipete/backup-birdclaw.git",
		"autoSync": true,
		"staleAfterSeconds": 900
	}
}
```

### `accounts.default`

Set a Birdclaw account username (with or without `@`) or stored account ID. Commands with an `--account` option use this value when the flag is omitted. An explicit `--account` always wins.

Selection is per operation. Birdclaw resolves the existing account row, routes xurl through that username for the command, then restores the process environment. It never creates an account, changes the database default, or binds a live credential to stored data.

### `actions.transport`

- Controls compose writes (post, reply, and DM compose) and moderation writes
  that use the actions policy. `auto` and `xurl` allow the implemented xurl
  write path.
- `bird` explicitly rejects post, reply, and DM compose: those writes have no Bird implementation.

`BIRDCLAW_ACTIONS_TRANSPORT` overrides this setting for one process. For
block/unblock/mute, `auto` tries Bird first and then falls back to verified xurl;
Twitter still rejects pure OAuth2 block writes for many accounts.
DM request mutations (`dms accept`, `dms reject`, and `dms block`) use Bird
directly and do not use `actions.transport`.

### `live.dataSource`

This is the global transport choice for live reads and syncs. Its values are
`bird`, `xurl`, and `auto`; `auto` runs the operation's supported automatic
strategy. An explicit operation mode takes precedence. The remaining order is
`BIRDCLAW_LIVE_DATA_SOURCE`, `live.dataSource`, the legacy
`BIRDCLAW_MENTIONS_DATA_SOURCE`, legacy `mentions.dataSource`, then that
operation's capability default.

`mentions.dataSource` and `BIRDCLAW_MENTIONS_DATA_SOURCE` remain compatibility
aliases. They should be used only for existing installations; they no longer
describe a mentions-only global setting.

`mentions.birdCommand` overrides the `bird` binary path when you want to point at a non-`PATH` build.

## Prompt templates

The Config page can edit the user-controlled prompt text for Today, Analyse,
and Discuss. Custom templates use a fixed feature-to-file mapping:

| Feature | File |
| --- | --- |
| Today | `~/.birdclaw/prompts/period-digest.md` |
| Analyse | `~/.birdclaw/prompts/profile-analysis.md` |
| Discuss | `~/.birdclaw/prompts/search-discussion.md` |

Each file is UTF-8 Markdown with a schema line followed by one system marker
and one requirements marker, in that order:

```markdown
<!-- birdclaw-prompt-schema: 1 -->

<!-- birdclaw-prompt-system -->
Editable system text

<!-- birdclaw-prompt-requirements -->
Editable requirements
```

A missing file means the built-in defaults are active. Restore default deletes
the custom file. Invalid schema or marker structure is surfaced in Config;
defaults are shown, but saving requires confirmation before the original file
is replaced. Marker strings are reserved and rejected inside editable content.
Saves create the `prompts/` directory as needed and use a temporary file plus a
same-directory rename so readers see either the old complete version or the new
complete version.

The machine-readable output protocol remains owned by the application and is
appended to the editable text. The effective prompt hash covers both editable
text and that locked protocol. Changing either changes result-cache identity;
the next production generation may therefore incur real AI usage charges.
Saving during an active generation can also cause its old-prompt result not to
match the new prompt and trigger another generation.

Prompt Playgrounds send unsaved drafts to the configured AI provider using
local data only. They bypass result caches, active-generation registries,
business-table writes, live X reads, avatar prefetch, and automatic backup.
Today and Discuss stream results; Analyse returns one completed response.
Discuss intentionally uses local-only search, so its live-search prompt line can
differ from a production run. Empty local datasets are reported before any AI
request.

The Config UI uses these internal, local-web API paths:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/api/prompt-templates` | Read or save one feature template |
| `POST` | `/api/prompt-templates/reset` | Delete one custom template |
| `POST` | `/api/prompt-playground/period-digest` | Stream a Today draft run |
| `POST` | `/api/prompt-playground/profile-analysis` | Run an Analyse draft |
| `POST` | `/api/prompt-playground/search-discussion` | Stream a Discuss draft run |

Custom prompt files are not currently included in portable backups. See the
[v6 design specification](superpowers/specs/2026-07-28-prompt-templates-playground-design.md)
for cache, protocol, and isolation decisions.

### `backup.*`

See [Backup](backup.md). When `autoSync` is enabled, read commands pull + merge from Git only when the last check is stale, and data-changing commands push back automatically. Set `BIRDCLAW_BACKUP_AUTO_SYNC=0` to disable for one process.

## Environment variables

| Variable                       | Purpose                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BIRDCLAW_HOME`                | Override the storage root (`~/.birdclaw` by default)                                                                                                 |
| `BIRDCLAW_CONFIG`              | Read and write config at a non-default path                                                                                                          |
| `BIRDCLAW_ACTIONS_TRANSPORT`   | Override the transport for compose (post, reply, and DM compose) and policy-backed moderation writes with `auto`, `xurl`, or `bird` for one process |
| `BIRDCLAW_LIVE_DATA_SOURCE`    | Override global live read/sync transport with `auto`, `xurl`, or `bird` for one process                                                              |
| `BIRDCLAW_MENTIONS_DATA_SOURCE`| Legacy alias for `BIRDCLAW_LIVE_DATA_SOURCE`; lower precedence than the new variable                                                                |
| `BIRDCLAW_BIRD_COMMAND`        | Override the `bird` executable used by live Bird transports                                                                                          |
| `BIRDCLAW_BASH_COMMAND`        | Override the Git Bash executable used for Bird subprocess redirection on Windows                                                                     |
| `BIRDCLAW_HOST`                | Host interface for the production `birdclaw serve` listener; defaults to `127.0.0.1`                                                                 |
| `BIRDCLAW_PORT`                | Port for the production `birdclaw serve` listener; defaults to `3000`                                                                                |
| `BIRDCLAW_ALLOWED_HOSTS`       | Comma-separated extra hostnames accepted by the source `pnpm dev` server                                                                             |
| `BIRDCLAW_LOCAL_WEB`           | Internal local-server mode; production derives local access from the peer socket, while forwarded/proxied requests still require remote-token config |
| `BIRDCLAW_WEB_TOKEN`           | Optional app-level token for remote web API access; send as `x-birdclaw-token` or `birdclaw_token`                                                   |
| `BIRDCLAW_ALLOW_REMOTE_WEB`    | Set to `1` to allow remote access through a trusted private proxy                                                                                    |
| `BIRDCLAW_MCP_TOKEN`           | Dedicated 32+ byte bearer secret required by the read-only `/mcp` endpoint                                                                            |
| `BIRDCLAW_MCP_PUBLIC_URL`      | Exact public MCP URL, including `/mcp`; enables strict Host/Origin checks but does not terminate TLS                                                   |
| `BIRDCLAW_DISABLE_LIVE_WRITES` | Set to `1` to block any live mutation (used by tests and CI)                                                                                         |
| `BIRDCLAW_BACKUP_AUTO_SYNC`    | Set to `0` to disable auto-sync for one process                                                                                                      |
| `NO_COLOR`                     | Disable ANSI color in human output                                                                                                                   |
| `OPENAI_API_KEY`               | Enable inbox scoring and low-signal filtering                                                                                                        |
| `BIRDCLAW_OPENAI_MODEL`        | Override the model used for inbox scoring (default `gpt-5.2`)                                                                                        |
| `BIRDCLAW_OPENAI_BASE_URL`     | Point at an OpenAI-compatible server (e.g. Ollama `http://localhost:11434/v1`); takes precedence over the compatible `OPENAI_BASE_URL` fallback; default `https://api.openai.com/v1` |
| `BIRDCLAW_DEBUG`               | Set to any value to log OpenAI request URLs, statuses, and error bodies to stderr                                                                   |

`BIRDCLAW_DISABLE_LIVE_WRITES=1` is set automatically in CI and Playwright runs so test code can never publish a tweet, send a DM, or block an account.

## Multi-account

birdclaw was built around multiple accounts in a single shared database from day one. Pass `--account <username>` (or a stored account ID) on commands that support account selection, including moderation, profile hydration, profile reply inspection, mentions, DMs, live sync, and scheduled jobs.

```bash
birdclaw sync timeline --account steipete --mode xurl
birdclaw import hydrate-profiles --account @steipete
birdclaw compose post --account acct_primary "Ship it."
```

For a recurring choice, set `accounts.default` in `config.json`. Explicit flags remain reversible one-command overrides. xurl can select a named OAuth2 account; Bird has one active cookie identity, so Bird-backed operations verify that identity matches the selected Birdclaw account before reading or writing.

Per-account state — cursors, transport preferences, last-sync watermarks, OpenAI score caches — lives inside the same `birdclaw.sqlite`. There is no per-account directory tree.

## Transport selection

Archive imports and local reads need no live transport. For live reads and syncs,
an explicit operation mode wins over `BIRDCLAW_LIVE_DATA_SOURCE`,
`live.dataSource`, the legacy mentions environment/config aliases, and the
operation's capability default. Compose (post, reply, and DM compose) and
policy-backed moderation writes instead use command `--transport`,
`BIRDCLAW_ACTIONS_TRANSPORT`, `actions.transport`, then `auto`. DM request
mutations use Bird directly.

## Disabling live writes

For dry runs, demos, or development against a fresh archive:

```bash
export BIRDCLAW_DISABLE_LIVE_WRITES=1
birdclaw compose post "this will not actually post"
birdclaw blocks add @someone --account acct_primary
```

Both commands record the intent locally where applicable but skip every transport call. Tests and CI rely on this exact mechanism.
