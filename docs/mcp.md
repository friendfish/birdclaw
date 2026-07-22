---
title: MCP server
description: "Expose cached tweets to agents through a secured, read-only MCP endpoint."
---

# MCP server

Birdclaw can serve its web app and an adapter-owned Streamable HTTP MCP endpoint
from the same `birdclaw serve` process. The endpoint is exactly `/mcp`; it stays
disabled until both MCP security settings are present. The production adapter
requires a loopback TCP peer, so a same-host private proxy can reach MCP but a
direct LAN or internet connection to the origin cannot.

The MCP surface is intentionally smaller than the web API:

- `search_tweets` searches cached Home, Mentions, or Authored tweets; liked and
  bookmarked filters apply to Home
- `get_tweet_thread` reads cached ancestor and descendant context
- no DMs
- no live X calls or sync
- no post, reply, moderation, backup, filesystem, or SQL tools
- no OpenAI calls

Every tool uses Birdclaw's query-only SQLite readers. Missing tweets stay
missing; MCP requests never fetch them from X.

Tweet text, profile fields, links, and media metadata are untrusted third-party
content. Tool text labels them as data. MCP clients must not treat returned
social content as instructions, credentials, authorization, or authority to
take actions or follow links.

## Prepare the database

Initialize or import Birdclaw before enabling MCP. MCP startup opens an existing
initialized database and requires the current schema; it never creates, seeds,
or migrates the database. Run a trusted CLI command such as `birdclaw init` or
an archive/backup import first, then confirm it succeeds:

```bash
birdclaw --json db stats
```

Upgrade the database with the normal trusted CLI before restarting a newer MCP
server. An agent request cannot trigger a migration.

## Configure

Generate a dedicated secret of at least 32 bytes:

```bash
openssl rand -base64 32
```

Set the secret and exact public MCP URL in the server environment:

```bash
export BIRDCLAW_MCP_TOKEN=$(openssl rand -base64 32)
export BIRDCLAW_MCP_PUBLIC_URL='http://127.0.0.1:3000/mcp'
birdclaw serve
```

`BIRDCLAW_MCP_TOKEN` must be at least 32 bytes, use RFC 6750 bearer-token
characters, and differ from `BIRDCLAW_WEB_TOKEN`. It is accepted only
as `Authorization: Bearer …` on `/mcp`; cookies, query parameters, and
`x-birdclaw-token` do not authenticate MCP requests. All methods authenticate;
only `POST` is implemented.

MCP reads are scoped to one server-side Birdclaw account. They use the default
account unless `BIRDCLAW_MCP_ACCOUNT` selects an existing account by id or
handle:

```bash
export BIRDCLAW_MCP_ACCOUNT='acct_primary'
# or: export BIRDCLAW_MCP_ACCOUNT='@example'
```

The setting applies to every client using the endpoint; clients cannot choose
or override the account in tool arguments. Startup fails if the selector does
not match a local account.

`BIRDCLAW_MCP_PUBLIC_URL` is a security boundary, not a display setting. It
requires the exact `/mcp` path, rejects query strings and fragments, requires an
exact request Host match, and requires an exact Origin match when a browser
sends Origin. Forwarded-host headers are not trusted.

HTTP is accepted only for loopback hosts. External MCP URLs must use HTTPS on a
dedicated hostname:

```bash
export BIRDCLAW_MCP_PUBLIC_URL='https://mcp.example.com/mcp'
```

The URL setting does not provide TLS. Keep the Birdclaw listener on loopback and
terminate TLS in a same-host private proxy or tunnel. Birdclaw reserves the
configured external hostname for MCP and denies every path other than `/mcp`;
the proxy must enforce the same deny-by-default rule. Do not serve the web UI or
`/api/*` from the MCP hostname, and never bind the MCP origin directly to a LAN
or public interface.

When neither MCP setting is present, MCP is disabled. If MCP is configured but
its token, URL, account, or database fails validation, `birdclaw serve` refuses
to start and reports the invalid setting.

## Connect a client

Use a Streamable HTTP MCP client that supports bearer authentication. For
Codex, either add the local endpoint from the CLI:

```bash
codex mcp add birdclaw \
  --url http://127.0.0.1:3000/mcp \
  --bearer-token-env-var BIRDCLAW_MCP_TOKEN
codex mcp get birdclaw --json
```

Or add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.birdclaw]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "BIRDCLAW_MCP_TOKEN"
```

Keep the token in the client's environment or secret manager, not in a
checked-in configuration file.

## Cloudflare Access

An external deployment requires all of these boundaries:

```text
MCP client
  -> dedicated Cloudflare Access application for mcp.example.com/mcp
  -> Service Auth policy matching only the MCP service token
  -> proxy/tunnel rule that denies every other path on mcp.example.com
  -> loopback Birdclaw listener
  -> query-only SQLite reader for one configured account
```

1. Reserve a dedicated hostname for MCP. Do not reuse the web application's
   hostname.
2. Create a Cloudflare Access application scoped to `mcp.example.com/mcp`.
3. Create a service token and attach a **Service Auth** policy that includes
   that token. Creating the credential alone does not authorize it.
4. Configure the tunnel or reverse proxy to forward only exact `/mcp` requests
   to the loopback Birdclaw listener and reject every other path for that
   hostname.
5. Send the Cloudflare service-token headers and the independent Birdclaw
   bearer token on every request.

See Cloudflare's guides for [service-token authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/),
[service-token credentials](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
and [path-specific Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

Place the outer credential in `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET`. Codex can map both environment variables to headers
without storing their values in `~/.codex/config.toml`:

```toml
[mcp_servers.birdclaw]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "BIRDCLAW_MCP_TOKEN"
env_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }
```

Cloudflare Access is defense in depth; Birdclaw still fails closed if its own
MCP token is missing or wrong. Cloudflare Managed OAuth is not automatically
trusted by Birdclaw. A future OAuth mode must validate the Access JWT signature,
issuer, audience, and expiry at the origin before it can replace the Birdclaw
bearer.

## Built-in limits

- 64 KiB request bodies, including chunked bodies
- 30-second application deadline, including slow/chunked body uploads
- 20-request burst, refilling at one request per second
- four concurrent requests per token
- JSON-RPC batches disabled; each request is charged separately
- 100 search results maximum
- 80 thread tweets maximum
- 500 query characters and 32 FTS-tokenized query terms
- globally broad searches matching more than 10,000 cached tweets rejected
- scoped searches matching more than 1,000 cached tweets rejected
- unfiltered account listings with more than 10,000 source rows rejected; add a
  search term to narrow them
- 2 MiB tool-result limit
- stateless JSON responses; no sessions or SSE listener
- `Cache-Control: no-store` on every response

Use the reverse proxy for an end-to-end request timeout, additional client rate
limits, request logging, and TLS. The application deadline cannot preempt
synchronous SQLite execution, so the broad-search and bounded-thread guards are
also enforced. Never log authorization headers, request bodies, search text, or
tweet content.

## Rotate or disable

Rotate access by replacing `BIRDCLAW_MCP_TOKEN` in the server and client
environments, then restart both. Keep it distinct from the web token. Disable
MCP by removing both `BIRDCLAW_MCP_TOKEN` and `BIRDCLAW_MCP_PUBLIC_URL`, then
restart Birdclaw.
