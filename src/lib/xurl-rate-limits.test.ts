// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	getXurlRateLimitSnapshot,
	recordXurlRateLimitEvent,
} from "./xurl-rate-limits";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_PROFILE_ANALYSIS_CONVERSATION_DELAY_MS;
	delete process.env.BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_RETRY_MS;
	delete process.env.BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_MAX_RETRIES;

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function setupDb() {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-rate-limits-"));
	tempDirs.push(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	return getNativeDb();
}

describe("xurl rate limits", () => {
	it("summarizes observed calls and 429s in the current window", () => {
		const db = setupDb();
		const now = new Date("2026-05-31T12:00:00.000Z");

		recordXurlRateLimitEvent(
			{
				endpoint: "tweets_search_recent",
				status: "ok",
				source: "profile-analysis:conversation",
				handle: "alice",
				at: "2026-05-31T11:59:00.000Z",
			},
			db,
		);
		recordXurlRateLimitEvent(
			{
				endpoint: "tweets_search_recent",
				status: "rate_limited",
				source: "profile-analysis:conversation",
				handle: "alice",
				detail: "Too Many Requests",
				at: "2026-05-31T11:58:00.000Z",
			},
			db,
		);
		recordXurlRateLimitEvent(
			{
				endpoint: "users_id_tweets",
				status: "ok",
				source: "profile-analysis:timeline",
				handle: "alice",
				at: "2026-05-31T11:40:00.000Z",
			},
			db,
		);

		const snapshot = getXurlRateLimitSnapshot(db, now);
		const recentSearch = snapshot.endpoints.find(
			(endpoint) => endpoint.key === "tweets_search_recent",
		);
		const userTweets = snapshot.endpoints.find(
			(endpoint) => endpoint.key === "users_id_tweets",
		);

		expect(snapshot.summary.totalCallsLastWindow).toBe(2);
		expect(snapshot.summary.rateLimitedLastWindow).toBe(1);
		expect(snapshot.summary.criticalEndpoints).toBe(1);
		expect(recentSearch).toMatchObject({
			callsLastWindow: 2,
			rateLimitedLastWindow: 1,
			status: "critical",
			estimatedRemaining: 298,
		});
		expect(userTweets).toMatchObject({
			callsLastWindow: 0,
			status: "quiet",
		});
		expect(snapshot.events).toHaveLength(3);
	});

	it("reports throttle env defaults and overrides", () => {
		const db = setupDb();
		process.env.BIRDCLAW_PROFILE_ANALYSIS_CONVERSATION_DELAY_MS = "42";
		process.env.BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_RETRY_MS = "5000";
		process.env.BIRDCLAW_PROFILE_ANALYSIS_RATE_LIMIT_MAX_RETRIES = "2";

		expect(getXurlRateLimitSnapshot(db).throttle).toEqual({
			conversationDelayMs: 42,
			rateLimitRetryMs: 5000,
			rateLimitMaxRetries: 2,
		});
	});

	it("keeps high-usage endpoints critical when a non-429 error is also present", () => {
		const db = setupDb();
		const now = new Date("2026-05-31T12:00:00.000Z");
		for (let index = 0; index < 270; index += 1) {
			recordXurlRateLimitEvent(
				{
					endpoint: "tweets_search_recent",
					status: "ok",
					source: "profile-analysis:conversation",
					at: "2026-05-31T11:59:00.000Z",
				},
				db,
			);
		}
		recordXurlRateLimitEvent(
			{
				endpoint: "tweets_search_recent",
				status: "error",
				source: "profile-analysis:conversation",
				detail: "parse failed",
				at: "2026-05-31T11:59:30.000Z",
			},
			db,
		);

		const recentSearch = getXurlRateLimitSnapshot(db, now).endpoints.find(
			(endpoint) => endpoint.key === "tweets_search_recent",
		);

		expect(recentSearch).toMatchObject({
			callsLastWindow: 271,
			errorsLastWindow: 1,
			status: "critical",
		});
	});
});
