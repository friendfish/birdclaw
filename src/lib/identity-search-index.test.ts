// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	ensureIdentitySearchIndexForDmProfiles,
	syncIdentitySearchIndexForProfileIds,
} from "./identity-search-index";

let homeDir = "";

describe("identity search index", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-identity-index-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		const db = getNativeDb();
		db.exec(`
      delete from identity_search_index;
      delete from dm_conversations;
      delete from profile_bio_entities;
      delete from profile_snapshots;
      delete from profile_affiliations;
      delete from profiles;
      delete from accounts;
    `);
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("indexes profile, affiliation, bio entity, and history identity signals", () => {
		const db = getNativeDb();
		expect(syncIdentitySearchIndexForProfileIds(db, [])).toEqual({
			profiles: 0,
			entries: 0,
		});

		db.exec(`
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        avatar_hue, avatar_url, location, url, verified_type, entities_json,
        created_at
      ) values
        (
          'profile_user_42', 'sam', 'Sam Builder', 'Building with @acme',
          100, 10, 42, 'https://img.example/sam.jpg', 'London',
          'https://sam.example', 'business',
          '{"description":{"urls":[{"expandedUrl":"https://bio.example"},{"expanded_url":"https://bio2.example"},{"url":"https://bio3.example"},{"url":""}]}}',
          '2026-01-01T00:00:00.000Z'
        ),
        (
          'profile_user_99', 'minimal', 'Minimal Person', '', 0, 0, 9,
          '', '', '', '', '{bad json',
          '2026-01-02T00:00:00.000Z'
        );

      insert into profile_affiliations (
        subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, is_active,
        first_seen_at, last_seen_at, raw_json, updated_at
      ) values (
        'profile_user_42', 'profile_org_acme', 'Acme', 'acme',
        null, 'https://x.com/acme', 'Acme', 'fixture', 1,
        '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z',
        '{}', '2026-05-01T00:00:00.000Z'
      );

      insert into profile_bio_entities (
        profile_id, kind, value, source, is_active, first_seen_at, last_seen_at,
        raw_json
      ) values
        ('profile_user_42', 'handle', '@acme', 'bio', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}'),
        ('profile_user_42', 'domain', 'acme.dev', 'profile_url', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}'),
        ('profile_user_42', 'company_phrase', 'Acme', 'bio', 1, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '{}');

      insert into profile_snapshots (
        profile_id, snapshot_hash, observed_at, last_seen_at, source, handle,
        display_name, bio, location, url, verified_type, followers_count,
        following_count, affiliations_json, raw_json
      ) values (
        'profile_user_42', 'hash1', '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z', 'fixture', 'oldsam', 'Old Sam',
        'Used to build OldCo', 'Vienna', 'https://old.example', 'blue',
        90, 8,
        '[null,"bad",{"organizationName":"OldCo","organizationHandle":"oldco","label":"OldCo","url":"https://old.example"}]',
        '{}'
      );
    `);

		const result = syncIdentitySearchIndexForProfileIds(db, [
			"profile_user_42",
			"profile_user_42",
			"profile_user_99",
		]);
		expect(result.profiles).toBe(2);
		expect(result.entries).toBeGreaterThanOrEqual(20);

		const rows = db
			.prepare(
				"select kind, value, normalized_value, source, weight from identity_search_index where profile_id = 'profile_user_42' order by kind, value",
			)
			.all() as Array<{
			kind: string;
			value: string;
			normalized_value: string;
			source: string;
			weight: number;
		}>;
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "profile_handle",
					value: "sam",
					weight: 45,
				}),
				expect.objectContaining({
					kind: "profile_bio_url",
					value: "https://bio.example",
				}),
				expect.objectContaining({
					kind: "profile_bio_url",
					value: "https://bio2.example",
				}),
				expect.objectContaining({
					kind: "profile_bio_url",
					value: "https://bio3.example",
				}),
				expect.objectContaining({
					kind: "affiliation",
					value: "Acme",
					source: "affiliation",
					normalized_value: "acme",
					weight: 90,
				}),
				expect.objectContaining({
					kind: "bio_handle",
					value: "@acme",
				}),
				expect.objectContaining({
					kind: "bio_domain",
					value: "acme.dev",
				}),
				expect.objectContaining({
					kind: "bio_company",
					value: "Acme",
				}),
				expect.objectContaining({
					kind: "profile_history",
					value: "oldsam",
					source: "history",
				}),
				expect.objectContaining({
					kind: "affiliation",
					value: "OldCo",
					source: "history",
				}),
			]),
		);

		expect(
			db
				.prepare(
					"select count(*) as count from identity_search_index where value = ''",
				)
				.get(),
		).toEqual({ count: 0 });
	});

	it("warms only missing DM participant rows for the requested account", () => {
		const db = getNativeDb();
		db.exec(`
      insert into accounts (id, name, handle, transport, is_default, created_at)
      values
        ('acct_primary', 'Peter', '@steipete', 'archive', 1, '2026-01-01T00:00:00.000Z'),
        ('acct_other', 'Other', '@other', 'archive', 0, '2026-01-01T00:00:00.000Z');

      insert into profiles (
        id, handle, display_name, bio, followers_count, avatar_hue, created_at
      ) values
        ('profile_user_42', 'sam', 'Sam Builder', 'Acme', 100, 42, '2026-01-01T00:00:00.000Z'),
        ('profile_user_99', 'max', 'Max Builder', 'OtherCo', 100, 99, '2026-01-01T00:00:00.000Z');

      insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at,
        unread_count, needs_reply
      ) values
        ('dm_primary', 'acct_primary', 'profile_user_42', 'Sam', '2026-05-01T00:00:00.000Z', 0, 0),
        ('dm_other', 'acct_other', 'profile_user_99', 'Max', '2026-05-01T00:00:00.000Z', 0, 0);
    `);

		expect(ensureIdentitySearchIndexForDmProfiles(db, "acct_primary")).toEqual(
			expect.objectContaining({ profiles: 1 }),
		);
		expect(
			db
				.prepare(
					"select distinct profile_id from identity_search_index order by profile_id",
				)
				.all(),
		).toEqual([{ profile_id: "profile_user_42" }]);

		expect(ensureIdentitySearchIndexForDmProfiles(db, "all")).toEqual(
			expect.objectContaining({ profiles: 1 }),
		);
		expect(
			db
				.prepare(
					"select distinct profile_id from identity_search_index order by profile_id",
				)
				.all(),
		).toEqual([
			{ profile_id: "profile_user_42" },
			{ profile_id: "profile_user_99" },
		]);
	});
});
