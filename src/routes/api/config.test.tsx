// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./config";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");
const tempRoots: string[] = [];

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	resetBirdclawPathsForTests();
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function useTempConfig(config: unknown) {
	const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-route-"));
	tempRoots.push(root);
	process.env.BIRDCLAW_HOME = root;
	writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
	resetBirdclawPathsForTests();
	return root;
}

describe("config api route", () => {
	it("returns the resolved Today width with existing configuration", async () => {
		useTempConfig({
			ai: { provider: "openai", apiKey: "secret" },
			ui: { todayMaxWidthPx: 1040 },
		});

		const response = await GET({
			request: new Request("http://localhost/api/config"),
		});

		await expect(response.json()).resolves.toEqual({
			ok: true,
			ai: { provider: "openai", apiKey: "secret" },
			language: { aiLanguage: "zh-CN", uiLanguage: "zh-CN" },
			ui: { todayMaxWidthPx: 1040 },
		});
	});

	it("updates the Today width without replacing unrelated configuration", async () => {
		const root = useTempConfig({
			ai: { provider: "openai", model: "gpt-test" },
			language: { aiLanguage: "en", uiLanguage: "zh-CN" },
			digest: { freshnessSeconds: 43_200 },
		});

		const response = await POST({
			request: new Request("http://localhost/api/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ui: { todayMaxWidthPx: 1080 } }),
			}),
		});

		await expect(response.json()).resolves.toEqual({
			ok: true,
			ai: { provider: "openai", model: "gpt-test" },
			language: { aiLanguage: "en", uiLanguage: "zh-CN" },
			ui: { todayMaxWidthPx: 1080 },
		});
		expect(
			JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")),
		).toEqual({
			ai: { provider: "openai", model: "gpt-test" },
			language: { aiLanguage: "en", uiLanguage: "zh-CN" },
			digest: { freshnessSeconds: 43_200 },
			ui: { todayMaxWidthPx: 1080 },
		});
	});

	it("rejects an out-of-range Today width without changing the config", async () => {
		const root = useTempConfig({
			digest: { freshnessSeconds: 43_200 },
			ui: { todayMaxWidthPx: 960 },
		});
		const before = readFileSync(path.join(root, "config.json"), "utf8");

		const response = await POST({
			request: new Request("http://localhost/api/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ui: { todayMaxWidthPx: 1201 } }),
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "Invalid config payload",
		});
		expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
	});
});
