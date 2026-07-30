// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensureBirdclawDirs,
	getBirdCommand,
	getBirdclawConfig,
	getBirdclawPaths,
	getDefaultAccountSelector,
	resetBirdclawPathsForTests,
	resolveActionsTransport,
	resolveDigestArchiveDir,
	resolveMentionsDataSource,
	setActionsTransport,
} from "./config";

const tempRoots: string[] = [];
const originalPath = process.env.PATH;
const originalLiveDataSource = process.env.BIRDCLAW_LIVE_DATA_SOURCE;
const originalMentionsDataSource = process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;

beforeEach(() => {
	delete process.env.BIRDCLAW_LIVE_DATA_SOURCE;
	delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	process.env.PATH = originalPath;
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_CONFIG;
	delete process.env.BIRDCLAW_ACTIONS_TRANSPORT;
	delete process.env.BIRDCLAW_BIRD_COMMAND;
	delete process.env.BIRDCLAW_DIGEST_ARCHIVE_DIR;
	if (originalLiveDataSource === undefined) {
		delete process.env.BIRDCLAW_LIVE_DATA_SOURCE;
	} else {
		process.env.BIRDCLAW_LIVE_DATA_SOURCE = originalLiveDataSource;
	}
	if (originalMentionsDataSource === undefined) {
		delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
	} else {
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = originalMentionsDataSource;
	}
	resetBirdclawPathsForTests();

	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("config", () => {
	it("uses BIRDCLAW_HOME when set", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;

		const paths = getBirdclawPaths();

		expect(paths.rootDir).toBe(tempRoot);
		expect(paths.dbPath).toBe(path.join(tempRoot, "birdclaw.sqlite"));
		expect(paths.configPath).toBe(path.join(tempRoot, "config.json"));
	});

	it("creates expected media directories", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = path.join(tempRoot, "custom-home");

		const paths = ensureBirdclawDirs();

		expect(paths.mediaOriginalsDir).toContain(path.join("media", "originals"));
		expect(paths.mediaThumbsDir).toContain(path.join("media", "thumbs"));
	});

	it("reads config from the homedir root", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		writeFileSync(
			path.join(tempRoot, "config.json"),
			JSON.stringify({
				accounts: {
					default: "  @steipete  ",
				},
				actions: {
					transport: "xurl",
				},
				mentions: {
					dataSource: "bird",
					birdCommand: "/tmp/custom-bird",
				},
			}),
		);

		expect(getBirdclawConfig()).toEqual({
			accounts: {
				default: "  @steipete  ",
			},
			actions: {
				transport: "xurl",
			},
			mentions: {
				dataSource: "bird",
				birdCommand: "/tmp/custom-bird",
			},
		});
		expect(getDefaultAccountSelector()).toBe("@steipete");
		expect(resolveMentionsDataSource()).toBe("bird");
		expect(resolveActionsTransport()).toBe("xurl");
		expect(getBirdCommand()).toBe("/tmp/custom-bird");
	});

	it("resolves bird from PATH before using the shell fallback", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		const birdPath = path.join(tempRoot, "bird");
		writeFileSync(birdPath, "#!/bin/sh\n");
		chmodSync(birdPath, 0o755);
		process.env.BIRDCLAW_HOME = tempRoot;
		process.env.PATH = tempRoot;

		expect(getBirdCommand()).toBe(birdPath);
	});

	it("lets env override config for the datasource", () => {
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "xurl";
		process.env.BIRDCLAW_ACTIONS_TRANSPORT = "bird";
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/env-bird";

		expect(resolveMentionsDataSource()).toBe("xurl");
		expect(resolveActionsTransport()).toBe("bird");
		expect(getBirdCommand()).toBe("/tmp/env-bird");
	});

	it("resolves live data source before legacy mentions source", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		writeFileSync(
			path.join(tempRoot, "config.json"),
			JSON.stringify({
				live: { dataSource: "xurl" },
				mentions: { dataSource: "bird" },
			}),
		);
		process.env.BIRDCLAW_LIVE_DATA_SOURCE = "bird";
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "auto";

		expect(resolveMentionsDataSource()).toBe("bird");
		expect(resolveMentionsDataSource("xurl")).toBe("xurl");

		delete process.env.BIRDCLAW_LIVE_DATA_SOURCE;
		expect(resolveMentionsDataSource()).toBe("xurl");

		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = tempRoot;
		writeFileSync(
			path.join(tempRoot, "config.json"),
			JSON.stringify({ mentions: { dataSource: "bird" } }),
		);
		expect(resolveMentionsDataSource()).toBe("auto");

		delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = tempRoot;
		expect(resolveMentionsDataSource()).toBe("bird");

		writeFileSync(path.join(tempRoot, "config.json"), "{}");
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = tempRoot;
		expect(resolveMentionsDataSource()).toBe("birdclaw");
	});

	it("rejects invalid explicit action transports instead of falling back", () => {
		process.env.BIRDCLAW_ACTIONS_TRANSPORT = "bird";

		for (const transport of ["invalid", "", " \t "]) {
			expect(() => resolveActionsTransport(transport)).toThrow(
				"Invalid action transport; expected auto, bird, or xurl",
			);
		}
		expect(resolveActionsTransport()).toBe("bird");
		expect(resolveActionsTransport("auto")).toBe("auto");
		expect(resolveActionsTransport("bird")).toBe("bird");
		expect(resolveActionsTransport("xurl")).toBe("xurl");
	});

	it("rejects invalid explicit mention data sources instead of falling back", () => {
		process.env.BIRDCLAW_LIVE_DATA_SOURCE = "xurl";
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";

		for (const mode of ["invalid", "", " \t "]) {
			expect(() => resolveMentionsDataSource(mode)).toThrow(
				"Invalid mentions data source; expected birdclaw, auto, bird, or xurl",
			);
		}
		expect(resolveMentionsDataSource("birdclaw")).toBe("birdclaw");
		expect(resolveMentionsDataSource("auto")).toBe("auto");
		expect(resolveMentionsDataSource("bird")).toBe("bird");
		expect(resolveMentionsDataSource("xurl")).toBe("xurl");
	});

	it("sets actions transport in the active config file", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		writeFileSync(
			path.join(tempRoot, "config.json"),
			JSON.stringify({
				mentions: {
					dataSource: "bird",
				},
			}),
		);

		expect(setActionsTransport("xurl")).toEqual({
			configPath: path.join(tempRoot, "config.json"),
			transport: "xurl",
		});
		expect(getBirdclawConfig()).toEqual({
			actions: {
				transport: "xurl",
			},
			mentions: {
				dataSource: "bird",
			},
		});
		expect(resolveActionsTransport()).toBe("xurl");
	});

	it("resolves the digest archive directory in explicit > env > config > default order", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;

		expect(resolveDigestArchiveDir()).toBe(
			path.join(tempRoot, "digest-archive"),
		);

		writeFileSync(
			path.join(tempRoot, "config.json"),
			JSON.stringify({ digest: { archiveDir: "/tmp/from-config" } }),
		);
		resetBirdclawPathsForTests();
		process.env.BIRDCLAW_HOME = tempRoot;
		expect(resolveDigestArchiveDir()).toBe(path.resolve("/tmp/from-config"));

		process.env.BIRDCLAW_DIGEST_ARCHIVE_DIR = "/tmp/from-env";
		expect(resolveDigestArchiveDir()).toBe(path.resolve("/tmp/from-env"));

		expect(resolveDigestArchiveDir("/tmp/from-param")).toBe(
			path.resolve("/tmp/from-param"),
		);
	});

	it("defaults bird command to PATH lookup", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		process.env.PATH = "";

		expect(getBirdCommand()).toBe("bird");
	});
});
