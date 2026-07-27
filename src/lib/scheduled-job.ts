import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { tryPromise } from "./effect-runtime";

export interface ScheduledJobRunMetadata {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	host: string;
	pid: number;
}

export interface ScheduledJobRun {
	readonly startedAt: string;
	finish(): ScheduledJobRunMetadata;
}

export type ScheduledJobLockRelease = () => Promise<void>;

function isFileExistsError(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

export function startScheduledJobRun(started = Date.now()): ScheduledJobRun {
	const startedAt = new Date(started).toISOString();
	return {
		startedAt,
		finish() {
			const finished = Date.now();
			return {
				startedAt,
				finishedAt: new Date(finished).toISOString(),
				durationMs: finished - started,
				host: os.hostname(),
				pid: process.pid,
			};
		},
	};
}

export async function appendScheduledJobAudit(logPath: string, entry: unknown) {
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function appendScheduledJobAuditEffect(logPath: string, entry: unknown) {
	return tryPromise(() => appendScheduledJobAudit(logPath, entry));
}

export async function acquireScheduledJobLock(
	lockPath: string,
	staleMs: number,
): Promise<ScheduledJobLockRelease | undefined> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	try {
		const handle = await fs.open(lockPath, "wx");
		try {
			await handle.writeFile(
				`${JSON.stringify({
					pid: process.pid,
					host: os.hostname(),
					startedAt: new Date().toISOString(),
				})}\n`,
				"utf8",
			);
		} finally {
			await handle.close();
		}
		return () => fs.rm(lockPath, { force: true });
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
		const stats = await fs.stat(lockPath).catch(() => undefined);
		if (stats && Date.now() - stats.mtimeMs > staleMs) {
			await fs.rm(lockPath, { force: true });
			return acquireScheduledJobLock(lockPath, staleMs);
		}
		return undefined;
	}
}

export function acquireScheduledJobLockEffect(
	lockPath: string,
	staleMs: number,
): Effect.Effect<(() => Effect.Effect<void>) | undefined, unknown> {
	return tryPromise(() => acquireScheduledJobLock(lockPath, staleMs)).pipe(
		Effect.map((release) =>
			release
				? () =>
						tryPromise(release).pipe(
							Effect.asVoid,
							Effect.catchAll(() => Effect.void),
						)
				: undefined,
		),
	);
}

// Read-only check for whether a lock is currently held, without acquiring or
// releasing it — for callers that just need to know "is a job running right
// now" (e.g. a status API, or a second entry point that should defer to
// whichever job already holds the lock) rather than compete for it.
export async function peekScheduledJobLock(
	lockPath: string,
	staleMs: number,
): Promise<boolean> {
	const stats = await fs.stat(lockPath).catch(() => undefined);
	if (!stats) return false;
	return Date.now() - stats.mtimeMs <= staleMs;
}

export function peekScheduledJobLockEffect(
	lockPath: string,
	staleMs: number,
): Effect.Effect<boolean, unknown> {
	return tryPromise(() => peekScheduledJobLock(lockPath, staleMs));
}
