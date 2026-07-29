// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "../lib/config";
import { getNativeDb, resetDatabaseForTests } from "../lib/db";

const mocks = vi.hoisted(() => ({
	lookupProfileViaBird: vi.fn(),
	lookupProfilesViaBird: vi.fn(),
	lookupUsersByIds: vi.fn(),
}));

vi.mock("#/lib/bird", () => ({
	lookupProfileViaBirdEffect: (target: string) =>
		Effect.tryPromise({
			try: () => mocks.lookupProfileViaBird(target),
			catch: (error) => error,
		}),
	lookupProfilesViaBirdEffect: (targets: string[]) =>
		Effect.tryPromise({
			try: () => mocks.lookupProfilesViaBird(targets),
			catch: (error) => error,
		}),
}));

vi.mock("#/lib/xurl", () => ({
	lookupUsersByIdsEffect: (ids: string[]) =>
		Effect.tryPromise({
			try: () => mocks.lookupUsersByIds(ids),
			catch: (error) => error,
		}),
}));

let homeDir = "";

describe("DM profile enrichment", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-dm-enrichment-"));
		process.env.BIRDCLAW_HOME = homeDir;
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		mocks.lookupProfileViaBird.mockReset();
		mocks.lookupProfilesViaBird.mockReset();
		mocks.lookupUsersByIds.mockReset();
		const db = getNativeDb();
		db.exec(`
      delete from dm_messages;
      delete from dm_conversations;
      delete from profiles;
      delete from accounts;
      delete from sync_cache;
    `);
		db.prepare(
			"insert into accounts (id, name, handle, transport, is_default, created_at) values ('acct_primary', 'Peter', '@steipete', 'archive', 1, '2026-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_user_42', 'id42', 'id42', 'Imported from archive user 42', 0, 210, '2026-01-01T00:00:00.000Z')",
		).run();
		db.prepare(
			"insert into dm_conversations (id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply) values ('dm_1', 'acct_primary', 'profile_user_42', 'id42', '2026-01-01T00:00:00.000Z', 0, 0)",
		).run();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("uses bird policy by default while preserving explicit xurl controls", async () => {
		mocks.lookupProfileViaBird.mockResolvedValue(null);
		const { enrichDmItems } = await import("./dm-command-helpers");

		const birdOnly = await enrichDmItems({}, { resolveProfiles: true });
		expect(birdOnly).toMatchObject({
			profileResolution: [
				expect.objectContaining({ source: "bird", status: "miss" }),
			],
		});
		expect(mocks.lookupUsersByIds).not.toHaveBeenCalled();

		mocks.lookupProfileViaBird.mockResolvedValueOnce(null);
		mocks.lookupUsersByIds.mockResolvedValueOnce([
			{ id: "42", username: "sam", name: "Sam Altman" },
		]);
		const forcedXurl = await enrichDmItems(
			{},
			{ resolveProfiles: true, refreshProfileCache: true, xurlFallback: true },
		);
		expect(forcedXurl).toMatchObject({
			profileResolution: [
				expect.objectContaining({ source: "xurl", status: "hit" }),
			],
		});
		expect(mocks.lookupUsersByIds).toHaveBeenCalledWith(["42"]);

		mocks.lookupProfileViaBird.mockResolvedValueOnce(null);
		await enrichDmItems(
			{},
			{ resolveProfiles: true, refreshProfileCache: true, xurlFallback: false },
		);
		expect(mocks.lookupUsersByIds).toHaveBeenCalledTimes(1);
	});
});
