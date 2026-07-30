// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { PROMPT_SYSTEM_MARKER } from "#/lib/prompt-templates";
import { getRouteHandler } from "#/test/route-handlers";
import { Route as PromptTemplatesRoute } from "./prompt-templates";
import { Route as PromptTemplatesResetRoute } from "./prompt-templates.reset";

const GET = getRouteHandler(PromptTemplatesRoute, "GET");
const POST = getRouteHandler(PromptTemplatesRoute, "POST");
const RESET = getRouteHandler(PromptTemplatesResetRoute, "POST");
let tempRoot = "";

beforeEach(() => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-prompt-api-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	resetBirdclawPathsForTests();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("prompt template API", () => {
	it("reads defaults, saves explicitly, and resets explicitly", async () => {
		const initial = await GET({
			request: new Request(
				"http://localhost/api/prompt-templates?feature=period-digest",
			),
		});
		expect(await initial.json()).toMatchObject({
			ok: true,
			template: { isCustom: false },
		});

		const saved = await POST({
			request: new Request("http://localhost/api/prompt-templates", {
				method: "POST",
				body: JSON.stringify({
					feature: "period-digest",
					system: "Custom system",
					requirements: "- Custom guidance",
				}),
			}),
		});
		expect(await saved.json()).toMatchObject({
			template: { isCustom: true, system: "Custom system" },
		});

		const reset = await RESET({
			request: new Request("http://localhost/api/prompt-templates/reset", {
				method: "POST",
				body: JSON.stringify({ feature: "period-digest" }),
			}),
		});
		expect(await reset.json()).toMatchObject({
			template: { isCustom: false },
		});
	});

	it("never interprets an incomplete save as reset", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/prompt-templates", {
				method: "POST",
				body: JSON.stringify({ feature: "period-digest" }),
			}),
		});
		expect(response.status).toBe(400);
	});

	it("returns a clear marker validation error", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/prompt-templates", {
				method: "POST",
				body: JSON.stringify({
					feature: "period-digest",
					system: `Example ${PROMPT_SYSTEM_MARKER}`,
					requirements: "- Fine",
				}),
			}),
		});
		expect(response.status).toBe(400);
		expect((await response.json()).message).toContain("reserved prompt marker");
	});
});
