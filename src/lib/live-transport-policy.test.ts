// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryEnvelopeSchema } from "./api-contracts";
import { resetBirdclawPathsForTests, writeBirdclawConfig } from "./config";
import {
	resolveLiveReadMode,
	resolveLiveSyncMode,
	resolveDirectMessagesReadMode,
	resolveMentionThreadReadMode,
	xurlDisabledDataSourceStatus,
	xurlDisabledTransportStatus,
} from "./live-transport-policy";

const originalEnvironment = {
	home: process.env.BIRDCLAW_HOME,
	config: process.env.BIRDCLAW_CONFIG,
	mentionsDataSource: process.env.BIRDCLAW_MENTIONS_DATA_SOURCE,
	liveDataSource: process.env.BIRDCLAW_LIVE_DATA_SOURCE,
};

let root = "";

function clearTestEnvironment() {
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_CONFIG;
	delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
	delete process.env.BIRDCLAW_LIVE_DATA_SOURCE;
}

function restoreEnvironmentVariable(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

beforeEach(() => {
	clearTestEnvironment();
	resetBirdclawPathsForTests();
});

afterEach(() => {
	resetBirdclawPathsForTests();
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	restoreEnvironmentVariable("BIRDCLAW_HOME", originalEnvironment.home);
	restoreEnvironmentVariable("BIRDCLAW_CONFIG", originalEnvironment.config);
	restoreEnvironmentVariable(
		"BIRDCLAW_MENTIONS_DATA_SOURCE",
		originalEnvironment.mentionsDataSource,
	);
	restoreEnvironmentVariable(
		"BIRDCLAW_LIVE_DATA_SOURCE",
		originalEnvironment.liveDataSource,
	);
	resetBirdclawPathsForTests();
});

describe("live transport policy", () => {
	it("resolves explicit modes before conflicting configured and env sources", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		writeBirdclawConfig({ mentions: { dataSource: "bird" } });
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "xurl";
		expect(resolveLiveReadMode()).toBe("xurl");
		expect(resolveLiveReadMode("bird")).toBe("bird");
		expect(resolveLiveReadMode("auto")).toBe("auto");
		expect(resolveLiveReadMode("xurl")).toBe("xurl");
	});

	it("rejects every defined mode outside the public live-read modes", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		writeBirdclawConfig({ mentions: { dataSource: "bird" } });
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "xurl";

		for (const mode of ["", "birdclaw", "invalid"]) {
			expect(() => resolveLiveReadMode(mode)).toThrow(
				"Invalid live-read mode; expected auto, bird, or xurl",
			);
		}
		expect(resolveLiveReadMode()).toBe("xurl");
	});

	it("resolves the direct environment source before configured Bird mode", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		writeBirdclawConfig({ mentions: { dataSource: "bird" } });
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "auto";
		expect(resolveLiveReadMode()).toBe("auto");
	});

	it("uses capability defaults for local-only configuration", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		resetBirdclawPathsForTests();
		expect(resolveLiveReadMode()).toBe("xurl");
		expect(resolveLiveSyncMode()).toBe("auto");
		expect(resolveMentionThreadReadMode()).toBe("bird");
		expect(resolveDirectMessagesReadMode()).toBe("bird");
	});

	it("uses global transport preference for direct messages without changing their default", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		writeBirdclawConfig({ live: { dataSource: "xurl" } });
		expect(resolveDirectMessagesReadMode()).toBe("xurl");
		process.env.BIRDCLAW_LIVE_DATA_SOURCE = "bird";
		expect(resolveDirectMessagesReadMode()).toBe("bird");
		expect(resolveDirectMessagesReadMode("auto")).toBe("auto");
	});

	it("rejects auto for mention-thread sync", () => {
		expect(() => resolveMentionThreadReadMode("auto")).toThrow(
			"Mention-thread sync supports only bird or xurl",
		);
	});

	it("builds stable disabled xurl statuses", () => {
		expect(xurlDisabledTransportStatus()).toEqual({
			availableTransport: "local",
			statusText: "xurl disabled by bird transport selection",
		});
		expect(
			queryEnvelopeSchema.shape.transport.parse(xurlDisabledTransportStatus()),
		).not.toHaveProperty("installed");
		expect(xurlDisabledDataSourceStatus()).toEqual({
			source: "xurl",
			label: "xurl",
			works: false,
			status: "warning",
			detail: "xurl disabled by bird transport selection",
			accounts: [],
		});
	});
});
