// @vitest-environment node
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBirdCommand } from "./bird-command";
import { resetBirdclawPathsForTests } from "./config";

let root = "";
let script = "";

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-bird-env-"));
	script = path.join(root, "fake-bird.cjs");
	vi.stubEnv("BIRDCLAW_HOME", root);
	vi.stubEnv("BIRDCLAW_CONFIG", path.join(root, "config.json"));
	vi.stubEnv("BIRDCLAW_BIRD_COMMAND", process.execPath);
	vi.stubEnv("AUTH_TOKEN", "inherited-auth");
	vi.stubEnv("CT0", "inherited-ct0");
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "0");
	resetBirdclawPathsForTests();
	writeFileSync(
		script,
		`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(root, "spawned"))}, 'yes');
if (process.argv.includes('--fail')) {
  console.log(process.env.AUTH_TOKEN);
  console.error(process.env.CT0);
  process.exit(1);
}
console.log(JSON.stringify({auth: process.env.AUTH_TOKEN, ct0: process.env.CT0, extra: process.env.BIRDCLAW_TEST_EXTRA}));
`,
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
	resetBirdclawPathsForTests();
	rmSync(root, { recursive: true, force: true });
});

function credentials(content = "AUTH_TOKEN=managed-auth\nCT0=managed-ct0\n") {
	mkdirSync(path.join(root, "credentials"), { mode: 0o700 });
	writeFileSync(path.join(root, "credentials", "bird.env"), content, {
		mode: 0o600,
	});
}

describe("managed credentials at the real Bird subprocess boundary", () => {
	it("passes the managed pair instead of inherited credentials", async () => {
		credentials();
		const result = await runBirdCommand([script]);
		expect(JSON.parse(result.stdout)).toEqual({
			auth: "managed-auth",
			ct0: "managed-ct0",
		});
	});

	it("preserves inherited credentials when no managed file exists", async () => {
		const result = await runBirdCommand([script]);
		expect(JSON.parse(result.stdout)).toEqual({
			auth: "inherited-auth",
			ct0: "inherited-ct0",
		});
	});

	it("applies explicit overrides last without discarding the managed environment", async () => {
		credentials();
		const result = await runBirdCommand([script], {
			env: { AUTH_TOKEN: "one-shot-auth", BIRDCLAW_TEST_EXTRA: "kept" },
		});
		expect(JSON.parse(result.stdout)).toEqual({
			auth: "one-shot-auth",
			ct0: "managed-ct0",
			extra: "kept",
		});
	});

	it("redacts credentials from failed command diagnostics and nested causes", async () => {
		credentials();
		const error = await runBirdCommand([script, "--fail"]).catch(
			(cause: unknown) => cause,
		);
		expect(error).toBeInstanceOf(Error);
		const diagnostic = `${String(error)} ${JSON.stringify(error)}`;
		expect(diagnostic).toContain("[REDACTED]");
		expect(diagnostic).not.toMatch(
			/managed-auth|managed-ct0|inherited-auth|inherited-ct0/,
		);
	});

	it("rejects a malformed managed file before spawning instead of falling back", async () => {
		credentials("AUTH_TOKEN=private-partial\n");
		await expect(runBirdCommand([script])).rejects.toThrow(
			/Invalid Bird credential file/,
		);
		expect(existsSync(path.join(root, "spawned"))).toBe(false);
	});

	it("keeps subprocess execution disabled in read-only deployments", async () => {
		credentials();
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		await expect(runBirdCommand([script])).rejects.toThrow(/read-only/);
		expect(existsSync(path.join(root, "spawned"))).toBe(false);
	});
});
