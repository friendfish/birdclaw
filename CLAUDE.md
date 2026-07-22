# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`birdclaw` is a local-first Twitter/X workspace: a single npm package that ships both a CLI (`bin/birdclaw.mjs`) and a TanStack Start web app, backed by one shared SQLite database at `~/.birdclaw/birdclaw.sqlite`. Despite `docs/spec.md` describing an aspirational `packages/*` monorepo layout, the actual repo is a single package — everything lives under `src/`.

## Commands

```bash
pnpm dev          # vite dev server on 127.0.0.1:3000 (BIRDCLAW_LOCAL_WEB=1)
pnpm cli <args>   # run the CLI from source via tsx, e.g. pnpm cli search tweets "x"
pnpm build        # vite build + esbuild-bundles src/cli.ts -> dist/cli/birdclaw.js
pnpm check        # format:check + lint + typecheck (run before considering work done)
pnpm test         # vitest run (via scripts/run-vitest.mjs, sanitizes inherited NODE_OPTIONS)
pnpm coverage     # vitest with coverage; thresholds: 85% lines/functions/statements, 80% branches
pnpm e2e          # playwright
```

Run a single test file or a filtered test:

```bash
pnpm test src/lib/queries.test.ts
pnpm test -- -t "some test name"
```

`pnpm check` and `pnpm coverage` are what CI (`.github/workflows/ci.yml`) runs, alongside `pnpm build`, `pnpm pack:smoke`, and `pnpm e2e`. Tests and CI set `BIRDCLAW_DISABLE_LIVE_WRITES=1` (also set by `src/test/setup.ts`) so nothing ever performs a real X/Twitter write during a test run.

Formatting/linting: `oxfmt` (tabs, double quotes, see `.oxfmtrc.json`) and `oxlint` — both invoked through `pnpm format`/`pnpm lint`, not run standalone against arbitrary paths.

## Architecture

### One core, two front doors

CLI commands (`src/cli/register-*.ts`, wired up in `src/cli.ts`) and web routes (`src/routes/**`, TanStack Start file-based routing, API routes under `src/routes/api/`) both call into the same `src/lib/*` modules — there is no separate business logic per surface. When adding a feature, the logic belongs in `src/lib`, with a thin CLI command and/or route handler on top.

### Effect boundary

Core I/O-heavy logic in `src/lib` is written with `effect` (`Effect.gen`, typed errors, `Effect.forEach`/`Effect.sleep` for concurrency/retry/pacing). Framework edges (CLI handlers, React event handlers, route handlers) stay plain `async`/`await` over Promise wrappers. The convention, when a module needs both:

```ts
export function runThingEffect(input: Input): Effect.Effect<Output, ThingError> { ... }
export function runThing(input: Input): Promise<Output> {
  return runEffectPromise(runThingEffect(input));
}
```

`runEffectPromise` / `runEffectBackground` (`src/lib/effect-runtime.ts`) convert Effect exits back into thrown errors or callback handlers at that boundary. See `docs/data-architecture.md` for the current list of migrated surfaces — new core logic should default to this pattern; only add a Promise wrapper at the outer edge if it simplifies the caller.

### Storage

- Native SQLite (`src/lib/sqlite.ts`, `src/lib/db.ts`), no ORM. Schema changes are append-only, transactional migrations in `src/lib/database-migrations.ts`, tracked via the SQLite `user_version` pragma — each migration's `version` must be exactly `currentVersion + 1` or it throws.
- FTS5 covers tweet/DM full-text search.
- Default data root is `~/.birdclaw` (`BIRDCLAW_HOME` overrides it): DB, media cache, avatar cache. Never assume a fixed path in tests — respect the configured/overridden root.
- Text backup format (`src/lib/backup.ts`) mirrors the SQLite state into deterministic, Git-friendly JSONL shards (`data/tweets/YYYY.jsonl`, `data/dms/YYYY.jsonl`, etc.) so a private archive can live in an ordinary Git repo without LFS.

### Transport adapters

Live reads/writes shell out to external CLIs — `xurl` and `bird` — rather than reimplementing X's API or owning their auth stores. Birdclaw is transport-agnostic: `auto` mode tries `xurl` first, falls back to `bird`, and the app works in archive/local-only mode with neither installed. See `src/lib/xurl.ts`, `src/lib/bird.ts`, `src/lib/bird-command.ts`, `src/lib/actions-transport.ts`. Do not add code that reads/writes `xurl`'s or `bird`'s own config/credential files directly.

### Sync jobs

Live sync per surface (authored tweets, mentions, mention-threads, likes, bookmarks, timeline, DMs, follow graph, X Lists) lives in `src/lib/*-live.ts` modules, cursor-based and idempotent, with results cached in `sync_cache` and merged into canonical tables. Scheduled jobs (`src/lib/account-sync-job.ts`, `src/lib/bookmark-sync-job.ts`, `src/lib/scheduled-job.ts`) append JSONL audit entries and can install macOS launchd agents (`src/lib/launchd.ts`).

### Web app / API layer

- `src/lib/runtime-services.ts` and `src/lib/server-runtime-services.ts` construct the shared service objects (DB, transports, etc.) injected into routes; `src/lib/api-client.ts` / `src/lib/api-contracts.ts` define the typed contract between the browser client and the `src/routes/api/*` server routes, including NDJSON streaming (`src/lib/ndjson-stream.ts`, `client-ndjson.ts`) for long-running AI/sync operations.
- `src/lib/production-server.ts` backs `birdclaw serve`, the built production server (loopback-only by default; `BIRDCLAW_ALLOW_REMOTE_WEB=1` and optionally `BIRDCLAW_WEB_TOKEN` gate remote access). The app intentionally has no auth layer otherwise — it's local-only.
- React components live in `src/components`; route-level data fetching hooks (`useTimelineRouteData.ts`, `useNdjsonRun.ts`) bridge routes to the API client.

### AI features

OpenAI-backed features (inbox ranking, `today`/digest, `discuss`) are layered on top of local SQLite data as an enrichment, never the source of truth — see `src/lib/openai.ts`, `src/lib/openai-response-runtime.ts`, `src/lib/inbox.ts`, `src/lib/period-digest.ts`, `src/lib/search-discussion.ts`. DMs are excluded from AI context unless explicitly opted in.

## Notes when making changes

- `docs/data-architecture.md` and `docs/spec.md` are the design references; they describe intent and sometimes get ahead of (or lag) actual code — verify against `src/` rather than assuming the docs are current.
- Coverage thresholds in `vitest.config.ts` are enforced (`pnpm coverage`); new `src/lib` modules need corresponding `*.test.ts` files, following the existing colocated-test convention.
- `src/routeTree.gen.ts`, `src/styles.css`, and a few route files are excluded from lint/format/coverage — don't hand-edit `routeTree.gen.ts`, it's generated by the TanStack Start Vite plugin.
- Any code path that could perform a live write (post/reply/block/mute/etc.) must respect `BIRDCLAW_DISABLE_LIVE_WRITES` so it stays inert under tests and CI.
