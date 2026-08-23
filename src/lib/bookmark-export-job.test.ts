// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildBookmarkExportLaunchAgentPlist,
	getDefaultBookmarkExportAuditLogPath,
	getDefaultBookmarkExportLockPath,
	installBookmarkExportLaunchAgent,
	runBookmarkExportJob,
	runBookmarkExportJobEffect,
} from "./bookmark-export-job";
import { resetBirdclawPathsForTests } from "./config";

const exportBookmarksMock = vi.hoisted(() => vi.fn());
const execFileAsyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

Object.defineProperty(
	execFileMock,
	Symbol.for("nodejs.util.promisify.custom"),
	{ value: execFileAsyncMock },
);

vi.mock("./bookmark-export", () => ({
	exportBookmarks: (...args: unknown[]) => exportBookmarksMock(...args),
	getDefaultBookmarkExportLockPath: () =>
		path.join(process.env.BIRDCLAW_HOME ?? "", "locks", "bookmark-export.lock"),
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

function makeTempDir(prefix: string) {
	const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

function successfulExport() {
	return {
		ok: true,
		accountId: "acct_primary",
		archiveDir: path.join(process.env.BIRDCLAW_HOME ?? "", "bookmarks"),
		mode: "incremental" as const,
		created: 2,
		updated: 1,
		unchanged: 3,
		conflicted: 0,
		indexEntries: 6,
		errors: [],
		startedAt: "2026-08-24T03:00:00.000Z",
		finishedAt: "2026-08-24T03:00:01.000Z",
	};
}

beforeEach(() => {
	process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-bookmark-export-job-");
	resetBirdclawPathsForTests();
	exportBookmarksMock.mockReset();
	exportBookmarksMock.mockResolvedValue(successfulExport());
	execFileAsyncMock.mockReset();
});

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	resetBirdclawPathsForTests();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("bookmark export job", () => {
	it("runs lazily and writes a successful JSONL audit entry", async () => {
		const logPath = path.join(process.env.BIRDCLAW_HOME ?? "", "audit.jsonl");
		const archiveDir = path.join(
			process.env.BIRDCLAW_HOME ?? "",
			"custom archive",
		);
		const effect = runBookmarkExportJobEffect({
			account: "acct_primary",
			archiveDir,
			full: true,
			logPath,
		});

		expect(existsSync(logPath)).toBe(false);
		expect(exportBookmarksMock).not.toHaveBeenCalled();
		const result = await Effect.runPromise(effect);

		expect(exportBookmarksMock).toHaveBeenCalledWith({
			account: "acct_primary",
			archiveDir,
			full: true,
			lockPath: path.join(
				process.env.BIRDCLAW_HOME ?? "",
				"locks",
				"bookmark-export.lock",
			),
			acquireLock: false,
		});
		expect(result).toMatchObject({
			job: "bookmark-export",
			ok: true,
			options: { account: "acct_primary", archiveDir, full: true },
			export: { created: 2, updated: 1, indexEntries: 6 },
		});
		expect(JSON.parse(readFileSync(logPath, "utf8"))).toMatchObject({
			job: "bookmark-export",
			ok: true,
		});
	});

	it("audits exporter failures instead of rejecting the scheduled run", async () => {
		const logPath = path.join(process.env.BIRDCLAW_HOME ?? "", "audit.jsonl");
		exportBookmarksMock.mockRejectedValue(new Error("archive disk is full"));

		const result = await runBookmarkExportJob({ logPath });

		expect(result).toMatchObject({
			job: "bookmark-export",
			ok: false,
			error: "archive disk is full",
		});
		expect(JSON.parse(readFileSync(logPath, "utf8"))).toMatchObject({
			ok: false,
			error: "archive disk is full",
		});
	});

	it("logs and skips when another bookmark export is running", async () => {
		const logPath = path.join(process.env.BIRDCLAW_HOME ?? "", "audit.jsonl");
		const lockPath = path.join(
			process.env.BIRDCLAW_HOME ?? "",
			"locks",
			"bookmark-export.lock",
		);
		await mkdir(path.dirname(lockPath), { recursive: true });
		await writeFile(lockPath, "{}\n", "utf8");

		const result = await runBookmarkExportJob({ logPath, lockPath });

		expect(result).toMatchObject({
			job: "bookmark-export",
			ok: true,
			skipped: "already-running",
		});
		expect(exportBookmarksMock).not.toHaveBeenCalled();
		expect(readFileSync(logPath, "utf8")).toContain(
			'"skipped":"already-running"',
		);
	});

	it("uses stable default audit and lock paths", () => {
		expect(getDefaultBookmarkExportAuditLogPath()).toBe(
			path.join(
				process.env.BIRDCLAW_HOME ?? "",
				"audit",
				"bookmark-export.jsonl",
			),
		);
		expect(getDefaultBookmarkExportLockPath()).toBe(
			path.join(
				process.env.BIRDCLAW_HOME ?? "",
				"locks",
				"bookmark-export.lock",
			),
		);
	});

	it("builds and installs a daily LaunchAgent without running it at load", async () => {
		const launchAgentsDir = makeTempDir("birdclaw-launchagents-");
		const agent = buildBookmarkExportLaunchAgentPlist({
			account: "acct_work",
			archiveDir: "~/Archive/bookmarks",
			full: true,
			program: "/opt/homebrew/bin/birdclaw",
			hour: 4,
			minute: 15,
		});

		expect(agent.schedule).toEqual({
			kind: "calendar",
			hour: 4,
			minute: 15,
		});
		expect(agent.runAtLoad).toBe(false);
		expect(agent.plist).toContain("<key>StartCalendarInterval</key>");
		expect(agent.plist).toContain("<false/>");
		expect(agent.programArguments).toContain("export-bookmarks");
		expect(agent.programArguments).toContain("acct_work");
		expect(agent.programArguments).toContain("--full");
		expect(agent.programArguments).toContain(
			path.join(os.homedir(), "Archive", "bookmarks"),
		);

		const result = await installBookmarkExportLaunchAgent({
			launchAgentsDir,
			program: "/opt/homebrew/bin/birdclaw",
			load: false,
		});

		expect(result.loaded).toBe(false);
		expect(existsSync(result.plistPath)).toBe(true);
		expect(execFileAsyncMock).not.toHaveBeenCalled();
	});

	it("rejects invalid explicit schedule fields before building a plist", () => {
		expect(() => buildBookmarkExportLaunchAgentPlist({ hour: 24 })).toThrow(
			"hour must be an integer from 0 to 23",
		);
		expect(() => buildBookmarkExportLaunchAgentPlist({ minute: 60 })).toThrow(
			"minute must be an integer from 0 to 59",
		);
	});
});
