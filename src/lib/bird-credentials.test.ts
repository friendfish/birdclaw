// @vitest-environment node
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import {
	clearBirdCredentials,
	getBirdCredentialStatus,
	getBirdCredentialsPath,
	mergeBirdCredentialEnvironment,
	readBirdCredentials,
	readBirdCredentialsFileStrict,
	writeBirdCredentials,
} from "./bird-credentials";

let tempRoot = "";
const originalAuthToken = process.env.AUTH_TOKEN;
const originalCt0 = process.env.CT0;

function restoreEnvironmentVariable(
	name: "AUTH_TOKEN" | "CT0",
	value?: string,
) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

beforeEach(() => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-credentials-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	delete process.env.AUTH_TOKEN;
	delete process.env.CT0;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	restoreEnvironmentVariable("AUTH_TOKEN", originalAuthToken);
	restoreEnvironmentVariable("CT0", originalCt0);
	resetBirdclawPathsForTests();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("bird credential store", () => {
	it("stores and reads exactly the required credential pair", () => {
		const status = writeBirdCredentials({
			authToken: "auth-value",
			ct0: "ct0-value",
		});

		expect(getBirdCredentialsPath()).toBe(
			path.join(tempRoot, "credentials", "bird.env"),
		);
		expect(readFileSync(getBirdCredentialsPath(), "utf8")).toBe(
			"AUTH_TOKEN=auth-value\nCT0=ct0-value\n",
		);
		expect(readBirdCredentials()).toEqual({
			authToken: "auth-value",
			ct0: "ct0-value",
		});
		expect(status).toEqual({
			configured: true,
			complete: true,
			updatedAt: expect.any(String),
		});
		expect(JSON.stringify(status)).not.toMatch(/auth-value|ct0-value/u);
	});

	it("requires both non-empty values and rejects line breaks", () => {
		expect(() =>
			writeBirdCredentials({ authToken: "", ct0: "ct0-value" }),
		).toThrow(/required/iu);
		expect(() =>
			writeBirdCredentials({ authToken: "auth-value", ct0: "" }),
		).toThrow(/required/iu);
		expect(() =>
			writeBirdCredentials({ authToken: "auth\nvalue", ct0: "ct0-value" }),
		).toThrow(/line break/iu);
		expect(() =>
			writeBirdCredentials({ authToken: "auth-value", ct0: "ct0\rvalue" }),
		).toThrow(/line break/iu);
		expect(existsSync(getBirdCredentialsPath())).toBe(false);
	});

	it("rejects partial, duplicate, malformed, and unknown assignments", () => {
		const credentialsDir = path.dirname(getBirdCredentialsPath());
		mkdirSync(credentialsDir, { recursive: true });
		const invalidContents = [
			"AUTH_TOKEN=auth-value\n",
			"AUTH_TOKEN=auth-value\nAUTH_TOKEN=other\nCT0=ct0-value\n",
			"AUTH_TOKEN=auth-value\nCT0\n",
			"AUTH_TOKEN=auth-value\nCT0=ct0-value\nEXTRA=unexpected\n",
			"export AUTH_TOKEN=auth-value\nCT0=ct0-value\n",
		];

		for (const content of invalidContents) {
			writeFileSync(getBirdCredentialsPath(), content, "utf8");
			expect(readBirdCredentials()).toBeNull();
			expect(getBirdCredentialStatus()).toMatchObject({
				configured: true,
				complete: false,
			});
		}
	});

	it("strictly distinguishes missing, invalid, and unreadable files", () => {
		const missingPath = path.join(tempRoot, "missing.env");
		const invalidPath = path.join(tempRoot, "invalid.env");
		const unreadablePath = path.join(tempRoot, "credential-directory");
		writeFileSync(invalidPath, "AUTH_TOKEN=only-one-value\n", "utf8");
		mkdirSync(unreadablePath);

		expect(readBirdCredentialsFileStrict(missingPath)).toBeUndefined();
		expect(() => readBirdCredentialsFileStrict(invalidPath)).toThrow(
			/invalid Bird credential file/iu,
		);
		expect(() => readBirdCredentialsFileStrict(unreadablePath)).toThrow(
			/unable to read Bird credential file/iu,
		);
	});

	it("treats shell-looking values as inert text", () => {
		const markerPath = path.join(tempRoot, "must-not-exist");
		const authToken = `$(touch ${markerPath})`;
		writeBirdCredentials({ authToken, ct0: "literal; false" });

		expect(readBirdCredentials()).toEqual({
			authToken,
			ct0: "literal; false",
		});
		expect(existsSync(markerPath)).toBe(false);
	});

	it("sets restrictive permissions and atomically replaces the published file", () => {
		writeBirdCredentials({ authToken: "first-auth", ct0: "first-ct0" });
		const credentialsPath = getBirdCredentialsPath();
		const credentialsDir = path.dirname(credentialsPath);
		const firstInode = statSync(credentialsPath).ino;

		writeBirdCredentials({ authToken: "second-auth", ct0: "second-ct0" });

		expect(statSync(credentialsDir).mode & 0o777).toBe(0o700);
		expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
		expect(statSync(credentialsPath).ino).not.toBe(firstInode);
		expect(readdirSync(credentialsDir)).toEqual(["bird.env"]);
		expect(readBirdCredentials()).toEqual({
			authToken: "second-auth",
			ct0: "second-ct0",
		});
	});

	it("reports status without values and clears the managed file", () => {
		expect(getBirdCredentialStatus()).toEqual({
			configured: false,
			complete: false,
		});
		writeBirdCredentials({ authToken: "hidden-auth", ct0: "hidden-ct0" });

		const configured = getBirdCredentialStatus();
		expect(configured.configured).toBe(true);
		expect(configured.complete).toBe(true);
		expect(Date.parse(configured.updatedAt ?? "")).not.toBeNaN();
		expect(configured).not.toHaveProperty("authToken");
		expect(configured).not.toHaveProperty("ct0");

		clearBirdCredentials();
		expect(getBirdCredentialStatus()).toEqual({
			configured: false,
			complete: false,
		});
		expect(readBirdCredentials()).toBeNull();
	});

	it("merges process, managed, and explicit environments in precedence order", () => {
		process.env.AUTH_TOKEN = "process-auth";
		process.env.CT0 = "process-ct0";
		process.env.BIRDCLAW_CREDENTIAL_TEST = "preserved";
		writeBirdCredentials({ authToken: "managed-auth", ct0: "managed-ct0" });

		expect(mergeBirdCredentialEnvironment()).toMatchObject({
			AUTH_TOKEN: "managed-auth",
			CT0: "managed-ct0",
			BIRDCLAW_CREDENTIAL_TEST: "preserved",
		});
		expect(
			mergeBirdCredentialEnvironment({
				AUTH_TOKEN: "explicit-auth",
				EXPLICIT_ONLY: "yes",
			}),
		).toMatchObject({
			AUTH_TOKEN: "explicit-auth",
			CT0: "managed-ct0",
			EXPLICIT_ONLY: "yes",
		});
		delete process.env.BIRDCLAW_CREDENTIAL_TEST;
	});
});
