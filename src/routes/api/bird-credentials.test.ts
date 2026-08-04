// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getBirdCredentialsPath } from "#/lib/bird-credentials";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./bird-credentials";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");
const DELETE = getRouteHandler(Route, "DELETE");
let tempRoot = "";

beforeEach(() => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-credentials-api-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_WEB_TOKEN;
	resetBirdclawPathsForTests();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("bird credentials API", () => {
	it("returns status without credential fields or values", async () => {
		const initial = await GET({
			request: new Request("http://localhost/api/bird-credentials"),
		});
		expect(await initial.json()).toEqual({
			ok: true,
			status: { configured: false, complete: false },
		});

		const authToken = "api-auth-secret";
		const ct0 = "api-ct0-secret";
		const saved = await POST({
			request: new Request("http://localhost/api/bird-credentials", {
				method: "POST",
				body: JSON.stringify({ authToken, ct0 }),
			}),
		});
		const savedText = await saved.text();
		expect(saved.status).toBe(200);
		expect(savedText).not.toContain(authToken);
		expect(savedText).not.toContain(ct0);
		expect(JSON.parse(savedText)).toEqual({
			ok: true,
			status: {
				configured: true,
				complete: true,
				updatedAt: expect.any(String),
			},
		});

		const reloaded = await GET({
			request: new Request("http://localhost/api/bird-credentials"),
		});
		const reloadedText = await reloaded.text();
		expect(reloadedText).not.toContain(authToken);
		expect(reloadedText).not.toContain(ct0);
		expect(JSON.parse(reloadedText).status).not.toHaveProperty("authToken");
		expect(JSON.parse(reloadedText).status).not.toHaveProperty("ct0");
	});

	it("requires a complete, newline-free pair without echoing submitted values", async () => {
		const secret = "must-not-be-echoed";
		const requests = [
			{ authToken: secret },
			{ ct0: secret },
			{ authToken: `${secret}\nsecond-line`, ct0: "valid-ct0" },
			{ authToken: "valid-auth", ct0: `${secret}\rsecond-line` },
		];

		for (const body of requests) {
			const response = await POST({
				request: new Request("http://localhost/api/bird-credentials", {
					method: "POST",
					body: JSON.stringify(body),
				}),
			});
			const text = await response.text();
			expect(response.status).toBe(400);
			expect(text).not.toContain(secret);
		}
	});

	it("clears the credential file and returns only unconfigured status", async () => {
		await POST({
			request: new Request("http://localhost/api/bird-credentials", {
				method: "POST",
				body: JSON.stringify({
					authToken: "clear-auth-secret",
					ct0: "clear-ct0-secret",
				}),
			}),
		});

		const response = await DELETE({
			request: new Request("http://localhost/api/bird-credentials", {
				method: "DELETE",
			}),
		});
		expect(await response.json()).toEqual({
			ok: true,
			status: { configured: false, complete: false },
		});
		expect(() => getBirdCredentialsPath()).not.toThrow();
		const reloaded = await GET({
			request: new Request("http://localhost/api/bird-credentials"),
		});
		expect((await reloaded.json()).status.configured).toBe(false);
	});

	it("protects every credential operation from cross-origin requests", async () => {
		process.env.BIRDCLAW_WEB_TOKEN = "web-secret";
		const headers = {
			origin: "https://evil.example",
			"x-birdclaw-token": "web-secret",
		};
		const responses = await Promise.all([
			GET({
				request: new Request("http://localhost/api/bird-credentials", {
					headers,
				}),
			}),
			POST({
				request: new Request("http://localhost/api/bird-credentials", {
					method: "POST",
					headers,
					body: JSON.stringify({ authToken: "a", ct0: "c" }),
				}),
			}),
			DELETE({
				request: new Request("http://localhost/api/bird-credentials", {
					method: "DELETE",
					headers,
				}),
			}),
		]);

		expect(responses.map((response) => response.status)).toEqual([
			403, 403, 403,
		]);
	});
});
