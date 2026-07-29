// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests, writeBirdclawConfig } from "./config";
import {
	resolveLiveReadMode,
	xurlDisabledDataSourceStatus,
	xurlDisabledTransportStatus,
} from "./live-transport-policy";

let root = "";
afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
	resetBirdclawPathsForTests();
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("live transport policy", () => {
	it("resolves explicit mode before configured Bird mode", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		resetBirdclawPathsForTests();
		writeBirdclawConfig({ mentions: { dataSource: "bird" } });
		expect(resolveLiveReadMode()).toBe("bird");
		expect(resolveLiveReadMode("auto")).toBe("auto");
		expect(resolveLiveReadMode("xurl")).toBe("xurl");
	});

	it("keeps the legacy live default for local-only configuration", () => {
		root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-policy-"));
		process.env.BIRDCLAW_HOME = root;
		resetBirdclawPathsForTests();
		expect(resolveLiveReadMode()).toBe("xurl");
		expect(resolveLiveReadMode(undefined, "auto")).toBe("auto");
	});

	it("builds stable disabled xurl statuses", () => {
		expect(xurlDisabledTransportStatus()).toEqual({
			installed: false,
			availableTransport: "local",
			statusText: "xurl disabled by bird transport selection",
		});
		expect(xurlDisabledDataSourceStatus()).toMatchObject({
			source: "xurl",
			works: false,
			status: "warning",
			accounts: [],
		});
	});
});
