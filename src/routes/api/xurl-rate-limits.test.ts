// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { getNativeDb, resetDatabaseForTests } from "#/lib/db";
import { recordXurlRateLimitEvent } from "#/lib/xurl-rate-limits";
import { getRouteHandler } from "#/test/route-handlers";
import { Route } from "./xurl-rate-limits";

const tempDirs: string[] = [];
const GET = getRouteHandler(Route, "GET");

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function setupDb() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-api-rates-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return getNativeDb();
}

describe("xurl rate limits api route", () => {
	it("returns observed xurl pressure as json", async () => {
		const db = setupDb();
		recordXurlRateLimitEvent(
			{
				endpoint: "tweets_search_recent",
				status: "rate_limited",
				source: "profile-analysis:conversation",
				handle: "alice",
			},
			db,
		);

		const response = await GET({
			request: new Request("http://localhost/api/xurl-rate-limits"),
		});
		const payload = await response.json();

		expect(response.headers.get("content-type")).toBe("application/json");
		expect(payload.summary.rateLimitedLastWindow).toBe(1);
		expect(payload.endpoints).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "tweets_search_recent",
					status: "critical",
				}),
			]),
		);
	});
});
