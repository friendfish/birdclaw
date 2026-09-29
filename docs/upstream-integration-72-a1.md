# Issue #72 — A1 backup import acceleration

Status: implemented for review; not yet merged. This is the first independently
verifiable unit of #72, not completion of the upstream integration ledger.

## Sources and scope

- Local HEAD and fetched origin/main: `a922df2cf66bdcb426adfc7be1db77605015328e`.
- Fixed upstream scope: `3ff0aafa42cee3f95b79db92eb101a089dec4cf9`.
- Upstream main fetched on 2026-09-29: `5a778ef968030ef110c31d32813b84d187ebf47e`.
  New commits beyond the fixed scope are not included or evaluated here.
- Ported: `f9bd9c8bd373943b8531b6d7a9172cc0aa6daeea` (steipete/birdclaw#112).
  Existing codecs, streaming SQLite iterator and read transactions satisfy its dependencies.

The port streams portable fingerprints in a read snapshot after the import write
transaction commits and skips recursive topology normalization for canonical singleton
revisions. Two additional guards preserve local behavior: singleton rank must be zero,
and merge imports inspect stored edges, membership and ranks before skipping a component.
The upstream tests are included alongside regression cases for these boundaries.

No schema, backup format, migration, feed, account, prompt, transport or AI changes.
Node/pnpm remain supported; no Bun/toolchain migration. Fingerprinting uses bounded row
iteration, but the overall import still loads backup rows into memory.

## Reproducible performance comparison

Run `pnpm exec tsx scripts/benchmark-backup-import.ts` on the baseline and this change.
The script uses 10,000 canonical singleton revisions, each with a 1 KiB text payload,
in temporary databases. Each of three rounds replaces an empty database and then
merge-imports the same backup again, with validation enabled. Every import asserts
the full counts and hash against the source fingerprint.

Local macOS arm64, Node 26.5.0, pnpm 10.34.5:

| Mode | Baseline runs (ms) | Updated runs (ms) | Median improvement |
| --- | --- | --- | --- |
| Replace | 4849, 4815, 4813 | 162, 143, 153 | 31.5× |
| Merge | 4547, 4543, 4531 | 127, 130, 123 | 35.8× |

All twelve import fingerprints matched:
`d6a4f56c043ca09ac7a91aedab0ecb9994b1f562ce8c14ffacf3d8fcf66b596f`.
These are synthetic singleton-heavy results, not a production database benchmark,
memory measurement, or guarantee for heavily edited tweet graphs.

## Baseline and recovery

Before production edits, all 1,931 existing tests passed; the two newly ported
upstream regression tests failed as expected. Targeted validation additionally
covers portable round trips, deterministic schema-v7 bytes/hashes, tombstones,
branched revision chains, connected singletons and existing merge topology.

Final validation: `pnpm check` (format, lint, typecheck), `pnpm test` (188 files,
1,938 tests), and `pnpm build` all passed. The two backup suites passed 31 tests.
Independent read-only review found the destination-topology issue described above;
the follow-up review confirmed the fix with no remaining blockers. No live X/AI
requests, production database access, Windows runtime tests or browser E2E runs.

Reverting this code requires no database migration or backup format conversion.
The writes remain atomic, but fingerprint errors occur after commit and do not
roll back imported rows. To undo the imported data itself, restore a pre-import
SQLite snapshot; reverting code alone does not undo an import.

## Remaining ledger decisions

The 2026-09-15 issue review remains authoritative: preserve local migrations 1–8
and append 9+ only when needed; do not support direct upstream SQLite adoption or
add schema-shape detection. Fork/upstream text-backup interchange remains deferred
until B1. Feed edges in text backups are a known deferred gap, not an A1 blocker.
A2/B1 migration implementation and the remaining A/B/C entries are outside this PR.
