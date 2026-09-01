// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./ui-config";

const tempRoots: string[] = [];
const GET = getRouteHandler(Route, "GET");

function useTempHome(config?: unknown) {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-ui-config-"));
	tempRoots.push(root);
	process.env.BIRDCLAW_HOME = root;
	if (config !== undefined) {
		writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
	}
	resetBirdclawPathsForTests();
}

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	resetBirdclawPathsForTests();
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("ui config api route", () => {
	it("returns only the resolved non-sensitive UI configuration", async () => {
		useTempHome({
			ai: { provider: "openai", apiKey: "must-not-leak" },
			language: { aiLanguage: "en", uiLanguage: "en" },
			ui: { todayMaxWidthPx: 1120 },
		});
		const response = await GET({
			request: new Request("http://localhost/api/ui-config"),
		});

		expect(response.headers.get("content-type")).toContain("application/json");
		await expect(response.json()).resolves.toEqual({
			ok: true,
			ui: { todayMaxWidthPx: 1120 },
		});
	});

	it.each([
		["missing", undefined],
		["invalid", { ui: { todayMaxWidthPx: 1400 } }],
	])(
		"falls back to the default width for %s configuration",
		async (_, config) => {
			useTempHome(config);
			const response = await GET({
				request: new Request("http://localhost/api/ui-config"),
			});

			await expect(response.json()).resolves.toEqual({
				ok: true,
				ui: { todayMaxWidthPx: 960 },
			});
		},
	);
});
