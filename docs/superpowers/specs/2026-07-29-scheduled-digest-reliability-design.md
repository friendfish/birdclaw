# Scheduled Digest Reliability Design

## Goal

Make scheduled period-digest archives use one explicit batch sync, honor the configured AI language, expose degraded syncs in durable metadata, and represent partially generated archives accurately in the Today UI.

This design implements GitHub issue #38 without changing the existing All -> Following -> For You generation order or the existing prompt-template work in the current branch.

## Scope

The change covers scheduled digest archive jobs for `today`, `24h`, `yesterday`, and `week`. It changes the scheduled job path, archive/audit metadata, archive-status polling, and archived-period UI states.

The change does not redesign account sync, add a general job queue, authenticate xurl, parallelize model calls, or change manual Today/24h generation.

## Batch Data Flow

Each scheduled run performs these phases while holding the existing period lock:

1. Resolve the run window, language, configured transport, archive paths, and requested content sources.
2. Run one batch pre-sync for all requested sources.
3. Record pre-sync steps and classify the batch as `fresh`, `degraded`, or `skipped`.
4. Generate each requested digest sequentially with `liveSync: false` and the resolved language.
5. Write each source archive with the same batch sync metadata and language.
6. Write the final audit entry and release the lock.

The pre-sync phase is one batch, not one network call. It deduplicates source requirements:

- Sync Following once when `all` or `following` is requested.
- Sync For You once with Bird when `all` or `for_you` is requested.
- Sync mentions once when `all` is requested.
- Sync mention threads once after mentions have been persisted and the relevant local mention IDs are known.

The configured read transport is used for Following and mentions. For You always uses Bird because xurl does not support that feed. When scheduled execution is configured for Bird, no xurl command is invoked.

## Sync Result Contract

The scheduled job records a batch-level sync result:

```ts
type DigestArchiveSyncStatus = "fresh" | "degraded" | "skipped";

interface DigestArchiveSyncStep {
	kind: "following" | "for_you" | "mentions" | "mention_threads";
	ok: boolean;
	requestedTransport: "bird" | "xurl";
	actualTransport?: "bird" | "xurl" | "cache";
	count: number;
	error?: string;
}

interface DigestArchiveSyncResult {
	status: DigestArchiveSyncStatus;
	attemptedAt: string;
	steps: DigestArchiveSyncStep[];
}

type DigestArchiveBatchStatus = "ok" | "degraded" | "failed";
```

`fresh` means every configured live-sync attempt succeeded; individual steps that are intentionally disabled by local-only configuration remain visible as `skipped` without degrading the whole batch. `degraded` means at least one attempted required step failed, returned partial data, or could not resolve its requested live transport, and generation continued from local data. The batch is `skipped` when the caller passes `liveSync: false` or every required step is skipped. For You is an intentional exception to the mentions transport setting because it has no local/xurl refresh equivalent: requested For You data always attempts Bird, and a Bird failure is recorded as degraded.

The mentions transport is resolved through `resolveMentionsDataSource()`, preserving the existing precedence of `BIRDCLAW_MENTIONS_DATA_SOURCE`, config, then the `birdclaw` local-only default.

Network or authentication failures do not abort archive generation. They remain visible in the audit and every archive JSON file. The final batch status is `failed` when any model/archive step fails, `degraded` when generation succeeds after an incomplete pre-sync, and `ok` otherwise. A degraded batch is therefore never represented as an indistinguishable complete success.

## Language Resolution

Scheduled archive language uses this precedence:

1. `DigestArchiveJobOptions.language`
2. `BIRDCLAW_DIGEST_LANGUAGE`
3. `getBirdclawConfig().language.aiLanguage`
4. no language constraint

The resolved value is normalized with the existing digest-language validation before any model call. The same resolved language is passed to every source and written to the audit and archive JSON.

Manual API behavior remains unchanged.

## Archive Compatibility

New archive files add these fields:

```ts
{
	"schemaVersion": 2,
	"language": "zh-CN",
	"status": "ok",
	"sync": { "status": "fresh", "attemptedAt": "...", "steps": [] }
}
```

The reader continues accepting existing schema-version-1 files that omit these fields. Old files map to an unknown historical sync state in memory; the UI does not reinterpret them as degraded.

The final audit entry adds `language`, `status`, and `sync`. Existing `ok` remains for backward compatibility. It is true only when every model/archive step succeeds and the final batch metadata is persisted successfully; an incomplete pre-sync alone does not make it false. Callers use `status` to distinguish complete, degraded, and failed batches.

Schema-v2 JSON updates use a same-directory temporary file followed by `rename`, so readers do not observe partially written JSON. This is an atomic-visibility guarantee only; the job does not claim `fsync`-level durability across abrupt power loss.

## UI State

Yesterday and Week continue reading archived files rather than starting live generation.

While the corresponding archive lock is active:

- The status endpoint exposes the active run date and configured source count; it polls every five seconds.
- The archive date list and current-run source entry poll every two seconds while that run is active.
- The UI derives completed sources from the active run date's `contentSources`.
- The status line displays `Generating scheduled digest N/total` using the configured source count.
- If the current-run source is not complete, the body displays `This source is still being generated.`
- An explicitly selected historical date remains a normal historical view and is never labeled as pending because a newer run is active.
- When the source file appears, React Query refetches it and the Markdown replaces the progress state without a manual reload.

When the lock is not active, the existing missing-archive message remains valid.

The design keeps all content-source tabs available so the user can inspect progress for any source. It does not disable a currently selected tab, which avoids awkward focus and URL-state behavior.

## Error Handling

Every pre-sync step captures a normalized error message. One step failing does not prevent independent remaining sync steps from running. Generation starts only after all required pre-sync steps have settled, ensuring each source reads the same final local state.

Model generation and archive-write failures keep the existing per-source retry behavior. A generation failure remains a failed source step, independently of whether pre-sync was fresh or degraded.

If language validation or required local setup fails before pre-sync begins, the batch fails normally and records the top-level error through the existing scheduled-job audit path.

## Testing

Focused tests will cover:

- Source requirements deduplicate Following, For You, mentions, and threads into one pre-sync batch.
- Bird configuration never calls xurl for the scheduled batch.
- A failed pre-sync step produces `degraded` and does not prevent model generation.
- `liveSync: false` produces `skipped` and performs no transport calls.
- Explicit language, environment language, and configured AI language follow the documented precedence.
- Every generated source receives `liveSync: false` and the same normalized language.
- Version-2 archives and audit entries contain language/status/sync metadata; version-1 archives still load.
- Archived Today UI polls while the period is running, shows `N/3`, avoids false `Ready`/missing states, and renders the source when it becomes available.

After focused tests, run the repository typecheck/lint gate, the full test suite, and the production build.

## Non-Goals

- Authenticating or repairing xurl credentials.
- Replacing launchd or changing schedule times.
- Parallel model generation.
- Atomic all-or-nothing publication of the entire date directory.
- A general persistent job manifest or queue.
- Changing the existing 30-minute account-sync schedule.
