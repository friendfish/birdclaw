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
	metadata: Pick<ScheduledJobLockMetadata, "runDate" | "totalSources"> = {},
): Promise<ScheduledJobLockRelease | undefined> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const ownerId = randomUUID();
	try {
		const handle = await fs.open(lockPath, "wx");
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
		return async () => {
			const raw = await fs.readFile(lockPath, "utf8").catch(() => undefined);
			if (raw === undefined) return;
			try {
				const metadata = JSON.parse(raw) as Partial<ScheduledJobLockMetadata>;
				if (metadata.ownerId !== ownerId) return;
			} catch {
				return;
			}
			await fs.rm(lockPath, { force: true });
		};
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
		const existingMetadata = await peekScheduledJobLockMetadata(
			lockPath,
			staleMs,
		);
		if (!existingMetadata) {
			await fs.rm(lockPath, { force: true });
			return acquireScheduledJobLock(lockPath, staleMs, metadata);
		}
		return undefined;
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
): Promise<ScheduledJobLockMetadata | undefined> {
	const stats = await fs.stat(lockPath).catch(() => undefined);
	if (!stats) return undefined;
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
		if (
			Date.now() - stats.mtimeMs > staleMs &&
			!(metadata.host === os.hostname() && processIsAlive(metadata.pid))
		) {
			return undefined;
		}
		return metadata;
	} catch {
		// Older or partially-written locks still represent active work. Their
		// mtime gives status readers a stable date without mutating the lock.
		if (Date.now() - stats.mtimeMs > staleMs) return undefined;
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
