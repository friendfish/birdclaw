// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();
const accessMock = vi.fn();

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
	promisify: vi.fn(() => execFileAsyncMock),
}));

vi.mock("node:fs/promises", () => ({
	access: accessMock,
}));

const tempRoots: string[] = [];

describe("bird command Effect boundary", () => {
	afterEach(() => {
		vi.resetModules();
		execFileAsyncMock.mockReset();
		accessMock.mockReset();
		delete process.env.BIRDCLAW_BIRD_COMMAND;
		delete process.env.BIRDCLAW_CONFIG;
		delete process.env.BIRDCLAW_HOME;
		delete process.env.BIRDCLAW_COMMAND_TEST;
		for (const tempRoot of tempRoots.splice(0)) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("returns a rejected promise instead of throwing synchronously on config parse failures", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-command-"));
		const configPath = path.join(tempDir, "config.json");
		writeFileSync(configPath, "{bad json", "utf8");
		process.env.BIRDCLAW_CONFIG = configPath;
		const { runBirdCommand } = await import("./bird-command");
		let promise: Promise<unknown> | undefined;

		expect(() => {
			promise = runBirdCommand(["version"]);
		}).not.toThrow();
		await expect(promise).rejects.toThrow(/JSON/);
		expect(execFileAsyncMock).not.toHaveBeenCalled();

		rmSync(tempDir, { recursive: true, force: true });
	});

	it("merges process, managed, and explicit credentials into the child environment", async () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-command-env-"),
		);
		tempRoots.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		process.env.BIRDCLAW_COMMAND_TEST = "process-value";
		const { writeBirdCredentials } = await import("./bird-credentials");
		writeBirdCredentials({
			authToken: "managed-auth",
			ct0: "managed-ct0",
		});
		execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });
		const { runBirdCommand } = await import("./bird-command");

		await runBirdCommand(["whoami"], {
			env: { AUTH_TOKEN: "explicit-auth", EXPLICIT_ONLY: "yes" },
		});

		expect(execFileAsyncMock).toHaveBeenCalledWith(
			"bird",
			["whoami"],
			expect.objectContaining({
				env: expect.objectContaining({
					AUTH_TOKEN: "explicit-auth",
					CT0: "managed-ct0",
					BIRDCLAW_COMMAND_TEST: "process-value",
					EXPLICIT_ONLY: "yes",
				}),
			}),
		);
		const serializedArguments = JSON.stringify(
			execFileAsyncMock.mock.calls[0]?.[1],
		);
		expect(serializedArguments).not.toMatch(
			/explicit-auth|managed-auth|managed-ct0/u,
		);
	});

	it("redacts managed credentials from Bird execution failures", async () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-command-redact-"),
		);
		tempRoots.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		const { writeBirdCredentials } = await import("./bird-credentials");
		writeBirdCredentials({
			authToken: "failure-auth",
			ct0: "failure-ct0",
		});
		execFileAsyncMock.mockRejectedValue(
			Object.assign(new Error("bird failed with failure-auth"), {
				stdout: "AUTH_TOKEN=failure-auth",
				stderr: "CT0=failure-ct0",
			}),
		);
		const { runBirdCommand } = await import("./bird-command");
		let error: unknown;

		try {
			await runBirdCommand(["whoami"]);
		} catch (cause) {
			error = cause;
		}

		const serialized = JSON.stringify(error);
		expect(serialized).not.toMatch(/failure-auth|failure-ct0/u);
		expect(serialized).toContain("[REDACTED]");
		expect(execFileAsyncMock.mock.calls[0]?.[1]).toEqual(["whoami"]);
	});
});
