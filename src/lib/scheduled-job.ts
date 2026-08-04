import { randomUUID } from "node:crypto";
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

export interface ScheduledJobLockMetadata {
	ownerId?: string;
	startedAt: string;
	host: string;
	pid: number;
	runDate?: string;
	totalSources?: number;
}

export const DEFAULT_SCHEDULED_JOB_LOCK_MAX_AGE_MS = 6 * 60 * 60_000;

export type ScheduledJobLockRelease = (() => Promise<void>) & {
	heartbeat(): Promise<boolean>;
};

function isFileExistsError(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

async function heartbeatScheduledJobLock(lockPath: string, ownerId: string) {
	let handle: Awaited<ReturnType<typeof fs.open>>;
	try {
		handle = await fs.open(lockPath, "r+");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return false;
		}
		throw error;
	}
	try {
		const current = JSON.parse(
			await handle.readFile("utf8"),
		) as Partial<ScheduledJobLockMetadata>;
		if (current.ownerId !== ownerId) return false;
		const now = new Date();
		await handle.utimes(now, now);
		return true;
	} catch {
		return false;
	} finally {
		await handle.close();
	}
}

async function tryCreateScheduledJobLock(
	lockPath: string,
	metadata: Pick<ScheduledJobLockMetadata, "runDate" | "totalSources">,
): Promise<ScheduledJobLockRelease | undefined> {
	const ownerId = randomUUID();
	let handle: Awaited<ReturnType<typeof fs.open>>;
	try {
		handle = await fs.open(lockPath, "wx");
	} catch (error) {
		if (isFileExistsError(error)) return undefined;
		throw error;
	}
	try {
		await handle.writeFile(
			`${JSON.stringify({
				ownerId,
				pid: process.pid,
				host: os.hostname(),
				startedAt: new Date().toISOString(),
				...(metadata.runDate ? { runDate: metadata.runDate } : {}),
				...(Number.isInteger(metadata.totalSources) &&
				(metadata.totalSources ?? 0) > 0
					? { totalSources: metadata.totalSources }
					: {}),
			})}\n`,
			"utf8",
		);
	} finally {
		await handle.close();
	}

	const release = (async () => {
		const raw = await fs.readFile(lockPath, "utf8").catch(() => undefined);
		if (raw === undefined) return;
		try {
			const current = JSON.parse(raw) as Partial<ScheduledJobLockMetadata>;
			if (current.ownerId !== ownerId) return;
		} catch {
			return;
		}
		await fs.rm(lockPath, { force: true });
	}) as ScheduledJobLockRelease;
	release.heartbeat = () => heartbeatScheduledJobLock(lockPath, ownerId);
	return release;
}

async function acquireReclamationLease(reclaimPath: string, staleMs: number) {
	const acquired = await tryCreateScheduledJobLock(reclaimPath, {});
	if (acquired) return acquired;
	if (await peekScheduledJobLockMetadata(reclaimPath, staleMs)) {
		return undefined;
	}

	// Never delete a stale lease based on an earlier observation: another
	// contender could already have replaced it. A child lease provides the same
	// exclusive-create arbitration recursively, including after repeated crashes.
	const releaseChild = await acquireReclamationLease(
		`${reclaimPath}.reclaim`,
		staleMs,
	);
	if (!releaseChild) return undefined;
	let releaseAncestor: ScheduledJobLockRelease | undefined;
	try {
		const ancestorExists = await fs
			.stat(reclaimPath)
			.then(() => true)
			.catch((error) => {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "ENOENT"
				) {
					return false;
				}
				throw error;
			});
		if (
			ancestorExists &&
			(await peekScheduledJobLockMetadata(reclaimPath, staleMs))
		) {
			return undefined;
		}
		if (ancestorExists) {
			await fs.rm(reclaimPath, { force: true });
		}

		// A delayed contender can create the ancestor as soon as it disappears.
		// Proceed only if this process wins the ancestor's exclusive create too.
		releaseAncestor = await tryCreateScheduledJobLock(reclaimPath, {});
		if (!releaseAncestor) return undefined;
		return async () => {
			await releaseAncestor?.();
			await releaseChild();
		};
	} finally {
		if (!releaseAncestor) await releaseChild();
	}
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
	metadata: Pick<ScheduledJobLockMetadata, "runDate" | "totalSources"> = {},
): Promise<ScheduledJobLockRelease | undefined> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const acquired = await tryCreateScheduledJobLock(lockPath, metadata);
	if (acquired) return acquired;

	const existingMetadata = await peekScheduledJobLockMetadata(
		lockPath,
		staleMs,
	);
	if (existingMetadata) return undefined;

	const reclaimPath = `${lockPath}.reclaim`;
	const releaseReclaim = await acquireReclamationLease(reclaimPath, staleMs);
	if (!releaseReclaim) return undefined;
	try {
		// Another contender may have reclaimed the lock before this lease was won.
		if (await peekScheduledJobLockMetadata(lockPath, staleMs)) return undefined;
		await fs.rm(lockPath, { force: true });
		return await tryCreateScheduledJobLock(lockPath, metadata);
	} finally {
		await releaseReclaim();
	}
}

export function acquireScheduledJobLockEffect(
	lockPath: string,
	staleMs: number,
	metadata: Pick<ScheduledJobLockMetadata, "runDate" | "totalSources"> = {},
): Effect.Effect<(() => Effect.Effect<void>) | undefined, unknown> {
	return tryPromise(() =>
		acquireScheduledJobLock(lockPath, staleMs, metadata),
	).pipe(
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
	return (await peekScheduledJobLockMetadata(lockPath, staleMs)) !== undefined;
}

export async function peekScheduledJobLockMetadata(
	lockPath: string,
	staleMs: number,
	maxAgeMs = DEFAULT_SCHEDULED_JOB_LOCK_MAX_AGE_MS,
): Promise<ScheduledJobLockMetadata | undefined> {
	const stats = await fs.stat(lockPath).catch(() => undefined);
	if (!stats) return undefined;
	const now = Date.now();
	if (now - stats.mtimeMs > staleMs) return undefined;
	const raw = await fs.readFile(lockPath, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as Partial<ScheduledJobLockMetadata>;
		const startedAt = new Date(parsed.startedAt ?? "");
		if (
			!Number.isFinite(startedAt.getTime()) ||
			typeof parsed.host !== "string" ||
			typeof parsed.pid !== "number" ||
			!Number.isInteger(parsed.pid)
		) {
			throw new Error("invalid scheduled job lock metadata");
		}
		const metadata: ScheduledJobLockMetadata = {
			...(typeof parsed.ownerId === "string" && parsed.ownerId
				? { ownerId: parsed.ownerId }
				: {}),
			startedAt: startedAt.toISOString(),
			host: parsed.host,
			pid: parsed.pid,
			...(typeof parsed.runDate === "string" &&
			/^\d{4}-\d{2}-\d{2}$/.test(parsed.runDate)
				? { runDate: parsed.runDate }
				: {}),
			...(typeof parsed.totalSources === "number" &&
			Number.isInteger(parsed.totalSources) &&
			parsed.totalSources > 0
				? { totalSources: parsed.totalSources }
				: {}),
		};
		if (now - startedAt.getTime() > maxAgeMs) return undefined;
		if (metadata.host === os.hostname() && !processIsAlive(metadata.pid)) {
			return undefined;
		}
		return metadata;
	} catch {
		// Older or partially-written locks still represent active work. Their
		// mtime gives status readers a stable date without mutating the lock.
		return {
			startedAt: stats.mtime.toISOString(),
			host: "unknown",
			pid: 0,
		};
	}
}

function processIsAlive(pid: number) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return Boolean(
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "EPERM",
		);
	}
}

export function peekScheduledJobLockEffect(
	lockPath: string,
	staleMs: number,
): Effect.Effect<boolean, unknown> {
	return tryPromise(() => peekScheduledJobLock(lockPath, staleMs));
}

export function peekScheduledJobLockMetadataEffect(
	lockPath: string,
	staleMs: number,
): Effect.Effect<ScheduledJobLockMetadata | undefined, unknown> {
	return tryPromise(() => peekScheduledJobLockMetadata(lockPath, staleMs));
}
