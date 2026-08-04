// @vitest-environment node
import type { ExecFileOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBirdCredentials } from "#/lib/bird-credentials";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { testBirdCredentials } from "./bird-credentials-test";

let tempRoot = "";

beforeEach(() => {
	tempRoot = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-credentials-test-api-"),
	);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_WEB_TOKEN;
	resetBirdclawPathsForTests();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("bird credentials test API", () => {
	it("runs bird whoami with managed credentials in the environment only", async () => {
		const authToken = "test-auth-secret";
		const ct0 = "test-ct0-secret";
		writeBirdCredentials({ authToken, ct0 });
		const runBirdCommand = vi.fn(
			async (_args: string[], _options?: ExecFileOptions) => ({
				stdout: "{}",
				stderr: "",
			}),
		);

		const response = await testBirdCredentials(
			new Request("http://localhost/api/bird-credentials-test", {
				method: "POST",
			}),
			{ runBirdCommand },
		);
		const responseText = await response.text();

		expect(response.status).toBe(200);
		expect(JSON.parse(responseText)).toEqual({ ok: true });
		expect(responseText).not.toContain(authToken);
		expect(responseText).not.toContain(ct0);
		expect(runBirdCommand).toHaveBeenCalledWith(
			["whoami"],
			expect.objectContaining({
				env: expect.objectContaining({ AUTH_TOKEN: authToken, CT0: ct0 }),
			}),
		);
		expect(runBirdCommand.mock.calls[0]?.[0]).not.toContain(authToken);
		expect(runBirdCommand.mock.calls[0]?.[0]).not.toContain(ct0);
	});

	it("does not invoke bird when managed credentials are missing", async () => {
		const runBirdCommand = vi.fn(async () => ({ stdout: "{}", stderr: "" }));

		const response = await testBirdCredentials(
			new Request("http://localhost/api/bird-credentials-test", {
				method: "POST",
			}),
			{ runBirdCommand },
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			error: "X credentials are not configured",
		});
		expect(runBirdCommand).not.toHaveBeenCalled();
	});

	it("redacts managed and token-shaped values from failures", async () => {
		const authToken = "failure-auth-secret";
		const ct0 = "failure-ct0-secret";
		writeBirdCredentials({ authToken, ct0 });
		const runBirdCommand = vi.fn(async () => {
			throw new Error(
				`AUTH_TOKEN=${authToken} CT0=${ct0} Bearer bearer-secret`,
			);
		});

		const response = await testBirdCredentials(
			new Request("http://localhost/api/bird-credentials-test", {
				method: "POST",
			}),
			{ runBirdCommand },
		);
		const text = await response.text();

		expect(response.status).toBe(502);
		expect(text).not.toContain(authToken);
		expect(text).not.toContain(ct0);
		expect(text).not.toContain("bearer-secret");
		expect(text).toContain("[REDACTED]");
	});
});
