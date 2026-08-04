// @vitest-environment node
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireScheduledJobLock,
	appendScheduledJobAudit,
	peekScheduledJobLockMetadata,
	startScheduledJobRun,
} from "./scheduled-job";

const tempDirs: string[] = [];

function makeTempDir() {
	const directory = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-job-runtime-"),
	);
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("scheduled job runtime", () => {
	it("appends JSONL audit entries with run metadata", async () => {
		const logPath = path.join(makeTempDir(), "audit", "job.jsonl");
		const run = startScheduledJobRun(Date.now() - 10);
		const entry = { job: "test", ok: true, ...run.finish() };

		await appendScheduledJobAudit(logPath, entry);

		expect(JSON.parse(readFileSync(logPath, "utf8"))).toMatchObject({
			job: "test",
			ok: true,
			host: os.hostname(),
			pid: process.pid,
		});
		expect(entry.durationMs).toBeGreaterThanOrEqual(10);
	});

	it("rejects active locks and replaces stale locks", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		const release = await acquireScheduledJobLock(lockPath, 1_000, {
			runDate: "2020-01-02",
			totalSources: 2,
		});

		expect(release).toBeTypeOf("function");
		await expect(
			peekScheduledJobLockMetadata(lockPath, 1_000),
		).resolves.toEqual(
			expect.objectContaining({
				host: os.hostname(),
				pid: process.pid,
				runDate: "2020-01-02",
				totalSources: 2,
				startedAt: expect.any(String),
			}),
		);
		await expect(
			acquireScheduledJobLock(lockPath, 1_000),
		).resolves.toBeUndefined();
		await release?.();
		expect(existsSync(lockPath)).toBe(false);

		writeFileSync(lockPath, "stale\n", "utf8");
		const old = new Date(Date.now() - 2_000);
		utimesSync(lockPath, old, old);
		const staleRelease = await acquireScheduledJobLock(lockPath, 1_000);

		expect(staleRelease).toBeTypeOf("function");
		expect(readFileSync(lockPath, "utf8")).toContain(`"pid":${process.pid}`);
		await staleRelease?.();
	});

	it("reclaims a lock whose heartbeat expired even when its pid is alive", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				ownerId: "live-owner",
				startedAt: new Date(Date.now() - 3_600_000).toISOString(),
				host: os.hostname(),
				pid: process.pid,
			})}\n`,
			"utf8",
		);
		const old = new Date(Date.now() - 3_600_000);
		utimesSync(lockPath, old, old);

		await expect(
			peekScheduledJobLockMetadata(lockPath, 60_000),
		).resolves.toBeUndefined();
		const replacement = await acquireScheduledJobLock(lockPath, 60_000);
		expect(replacement).toBeTypeOf("function");
		await replacement?.();
	});

	it("renews only the lock owned by the current release handle", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		const firstRelease = await acquireScheduledJobLock(lockPath, 1_000);
		expect(firstRelease).toBeTypeOf("function");
		const old = new Date(Date.now() - 2_000);
		utimesSync(lockPath, old, old);

		await expect(firstRelease?.heartbeat()).resolves.toBe(true);
		await expect(
			peekScheduledJobLockMetadata(lockPath, 1_000),
		).resolves.toMatchObject({ pid: process.pid });

		rmSync(lockPath, { force: true });
		const successorRelease = await acquireScheduledJobLock(lockPath, 1_000);
		expect(successorRelease).toBeTypeOf("function");
		utimesSync(lockPath, old, old);
		const successorMtime = statSync(lockPath).mtimeMs;

		await expect(firstRelease?.heartbeat()).resolves.toBe(false);
		expect(statSync(lockPath).mtimeMs).toBe(successorMtime);
		await successorRelease?.();
	});

	it("expires a lock at the absolute maximum age", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				ownerId: "reused-pid-owner",
				startedAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
				host: os.hostname(),
				pid: process.pid,
			})}\n`,
			"utf8",
		);

		await expect(
			peekScheduledJobLockMetadata(lockPath, 60_000, 6 * 60 * 60_000),
		).resolves.toBeUndefined();
	});

	it("does not let an old release remove a successor lock", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		const firstRelease = await acquireScheduledJobLock(lockPath, 60_000);
		expect(firstRelease).toBeTypeOf("function");
		rmSync(lockPath, { force: true });

		const secondRelease = await acquireScheduledJobLock(lockPath, 60_000);
		expect(secondRelease).toBeTypeOf("function");
		const secondOwner = JSON.parse(readFileSync(lockPath, "utf8")) as {
			ownerId?: string;
		};
		expect(secondOwner.ownerId).toEqual(expect.any(String));

		await firstRelease?.();
		expect(existsSync(lockPath)).toBe(true);
		expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject(
			secondOwner,
		);
		await secondRelease?.();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("serializes simultaneous stale-lock reclamation", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "stale\n", "utf8");
		const old = new Date(Date.now() - 2_000);
		utimesSync(lockPath, old, old);

		const contenders = await Promise.all([
			acquireScheduledJobLock(lockPath, 1_000),
			acquireScheduledJobLock(lockPath, 1_000),
		]);
		const owners = contenders.filter(
			(release): release is NonNullable<typeof release> => Boolean(release),
		);

		expect(owners).toHaveLength(1);
		expect(existsSync(lockPath)).toBe(true);
		await owners[0]?.();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not reclaim while another contender holds the reclamation lease", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "stale\n", "utf8");
		const old = new Date(Date.now() - 2_000);
		utimesSync(lockPath, old, old);
		writeFileSync(
			`${lockPath}.reclaim`,
			`${JSON.stringify({
				ownerId: "active-reclaimer",
				startedAt: new Date().toISOString(),
				host: os.hostname(),
				pid: process.pid,
			})}\n`,
			"utf8",
		);

		await expect(
			acquireScheduledJobLock(lockPath, 1_000),
		).resolves.toBeUndefined();
		expect(readFileSync(lockPath, "utf8")).toBe("stale\n");
	});

	it("recovers an abandoned reclamation lease", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "stale\n", "utf8");
		writeFileSync(`${lockPath}.reclaim`, "abandoned\n", "utf8");
		const old = new Date(Date.now() - 2_000);
		utimesSync(lockPath, old, old);
		utimesSync(`${lockPath}.reclaim`, old, old);

		const release = await acquireScheduledJobLock(lockPath, 1_000);

		expect(release).toBeTypeOf("function");
		expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
		await release?.();
	});

	it("serializes concurrent recovery of an abandoned reclamation lease", async () => {
		const lockPath = path.join(makeTempDir(), "locks", "job.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "stale\n", "utf8");
		writeFileSync(`${lockPath}.reclaim`, "abandoned\n", "utf8");
		const old = new Date(Date.now() - 2_000);
		utimesSync(lockPath, old, old);
		utimesSync(`${lockPath}.reclaim`, old, old);

		let activeOwners = 0;
		let maximumActiveOwners = 0;
		let acquisitions = 0;
		await Promise.all(
			Array.from({ length: 32 }, async () => {
				const release = await acquireScheduledJobLock(lockPath, 1_000);
				if (!release) return;
				acquisitions += 1;
				activeOwners += 1;
				maximumActiveOwners = Math.max(maximumActiveOwners, activeOwners);
				await new Promise((resolve) => setTimeout(resolve, 10));
				await release();
				activeOwners -= 1;
			}),
		);

		expect(acquisitions).toBeGreaterThanOrEqual(1);
		expect(maximumActiveOwners).toBe(1);
	});
});
