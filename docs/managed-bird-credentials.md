# Managed Bird credentials (fork rebuild)

Rebuild backlog [#74](https://github.com/friendfish/birdclaw/issues/74), R4.1.
This first slice adds the local credential store and connects it to the shared
Bird subprocess boundary. It does not add the Config page, credential-test API,
automatic renewal, or integration with native-web DM cookies.

## File and precedence

The store is `$BIRDCLAW_HOME/credentials/bird.env`, or
`~/.birdclaw/credentials/bird.env` when no home override is set. It contains exactly
two literal assignments, in either order, with an optional final newline:

```text
AUTH_TOKEN=your-auth-token
CT0=your-ct0
```

This is a **data file, not a shell script**. Do not add `export`, comments, shell
quoting, extra keys or blank lines. Values are not expanded or evaluated. Both
values must be nonblank and cannot contain newlines or NUL bytes. The store writer
publishes the pair atomically, with directory mode `0700` and file mode `0600` on
POSIX systems. Manually provisioned files need these same permissions; permission
bits are not an ACL guarantee on Windows.

Every call through `runBirdCommand` / `runBirdCommandEffect` merges environments
in this order, from lowest to highest priority:

1. Inherited process environment.
2. The complete managed pair, when present.
3. Explicit per-call `options.env` fields.

An explicit field overrides only that field; callers changing accounts should
provide both values together. No global environment variables are mutated.
A missing file leaves existing environment/legacy Bird behavior intact. A present
but invalid or unreadable file rejects the command before starting Bird. This is
an intentional improvement over the old fork's silent fallback: replace or remove
the bad file instead of unexpectedly trying browser credential discovery.

The existing account-verification and transport-selection rules still apply.
Providing a managed pair does not force selection of Bird. It supplies cookies
when an operation actually uses Bird. Native-web DM and xurl authentication remain
separate. Real Bird/OS validation is required before claiming that all Keychain
prompts have disappeared.

## Storage API and diagnostics

`src/lib/bird-credentials.ts` provides read, strict-read, write, clear and status
operations. Status contains only `configured`, `complete` and optional `updatedAt`;
it never returns the values. A malformed existing file is configured but incomplete.
Read-only deployments reject writes/clears, and the upstream subprocess guard
continues to reject Bird execution.

Failed Bird commands redact the effective AUTH_TOKEN/CT0 from error messages,
stdout, stderr and nested subprocess diagnostics using the upstream redactor.
Successful command payloads are left intact for the existing parsers; callers
must not log raw credential-bearing payloads. There is no new HTTP route or secret
readback endpoint in this slice. Keep the file out of Git and ordinary text backups.

## Verification and recovery

The credential-store tests exercise real files: strict parsing, literal values,
permissions, atomic replacement, failed validation, status and read-only writes.
The command integration tests launch a local fake Bird process and check its
actual environment, override behavior, failure diagnostics and rejection before
spawn. They do not use real cookies or contact X.

Run with the repository's pinned Bun toolchain:

```sh
bun --no-env-file run test src/lib/bird-credentials.test.ts src/lib/bird-command-credentials.test.ts src/lib/bird-command.test.ts src/lib/subprocess.test.ts
```

There is no database or config-schema migration. No UI/route changes are introduced,
so a new Playwright scenario is not applicable to R4.1; the Config/API follow-up
must add browser coverage when those surfaces are migrated. Node compatibility is
checked separately with `npm run test:node --` and the same test paths.

Reverting the code restores upstream credential handling without deleting the
managed file. To restore legacy discovery while keeping this code, remove the
managed file deliberately; do not source it into a shell. Existing scheduled jobs
and general launch environment files are not changed by this slice.

## Remaining R4 work

- Config UI and authenticated status/save/test/clear APIs, without secret readback.
- LaunchAgent integration that stores only a credential file path.
- Explicit native-web DM credential-sharing and account-validation decision.
- Real Bird/macOS and Windows verification; concurrent-process storage validation.

R4 remains incomplete until those agreed deliverables have their own evidence.
