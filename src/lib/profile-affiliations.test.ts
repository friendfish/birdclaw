// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	attachAffiliationsToProfiles,
	fetchProfileAffiliations,
	normalizeProfileAffiliationsFromUser,
	syncProfileAffiliationsFromUser,
} from "./profile-affiliations";

let homeDir = "";

describe("profile affiliations", () => {
	beforeEach(() => {
		homeDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-affiliations-"));
		process.env.BIRDCLAW_HOME = homeDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("normalizes official organization ids and metadata", () => {
		expect(
			normalizeProfileAffiliationsFromUser({
				id: "42",
				username: "sam",
				name: "Sam",
				affiliation: {
					organizationIds: ["org_1", "org_1", "org_2"],
					description: "OpenAI",
					url: "https://x.com/OpenAI",
					badgeUrl: "https://cdn.example/openai.png",
				},
			}),
		).toEqual([
			expect.objectContaining({
				organizationProfileId: "org_1",
				organizationName: "OpenAI",
				organizationHandle: "OpenAI",
				url: "https://x.com/OpenAI",
				badgeUrl: "https://cdn.example/openai.png",
			}),
			expect.objectContaining({
				organizationProfileId: "org_2",
				organizationName: "OpenAI",
			}),
		]);
	});

	it("returns no affiliations for missing or unusable payloads", () => {
		expect(
			normalizeProfileAffiliationsFromUser({
				id: "42",
				username: "sam",
				name: "Sam",
			}),
		).toEqual([]);
		expect(
			normalizeProfileAffiliationsFromUser({
				id: "42",
				username: "sam",
				name: "Sam",
				affiliation: {},
			}),
		).toEqual([]);
	});

	it("normalizes snake_case ids and ignores non-X URLs for handle inference", () => {
		expect(
			normalizeProfileAffiliationsFromUser({
				id: "42",
				username: "sam",
				name: "Sam",
				affiliation: {
					organization_ids: ["org_1"],
					label: "Acme",
					expanded_url: "https://acme.example",
				},
			}),
		).toEqual([
			expect.objectContaining({
				organizationProfileId: "org_1",
				organizationName: "Acme",
				url: "https://acme.example",
			}),
		]);
	});

	it("keeps badge-only highlighted labels as synthetic affiliations", () => {
		const [affiliation] = normalizeProfileAffiliationsFromUser({
			id: "42",
			username: "sam",
			name: "Sam",
			affiliation: {
				description: "Blacksmith",
				url: "https://www.blacksmith.sh",
				badge_url: "https://cdn.example/blacksmith.png",
			},
		});

		expect(affiliation).toEqual(
			expect.objectContaining({
				organizationProfileId: expect.stringMatching(/^profile_affiliation_/),
				organizationName: "Blacksmith",
				url: "https://www.blacksmith.sh",
				badgeUrl: "https://cdn.example/blacksmith.png",
			}),
		);
	});

	it("syncs, fetches, deduplicates, and attaches active affiliations", () => {
		const db = getNativeDb();
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, created_at) values ('profile_aff_user_42', 'aff_sam', 'Sam', '', 1, 1, '2026-01-01T00:00:00.000Z')",
		).run();
		expect(
			syncProfileAffiliationsFromUser(db, "profile_aff_user_42", {
				id: "42",
				username: "sam",
				name: "Sam",
				affiliation: {
					organizationIds: ["org_1", "org_2"],
					description: "OpenAI",
					url: "https://x.com/OpenAI",
					badgeUrl: "https://cdn.example/openai.png",
				},
			}),
		).toHaveLength(2);

		db.prepare(
			"update profile_affiliations set is_active = 0 where organization_profile_id = 'org_2'",
		).run();
		const fetched = fetchProfileAffiliations(db, ["profile_aff_user_42"]);
		expect(fetchProfileAffiliations(db, [])).toEqual(new Map());
		expect(fetched.get("profile_aff_user_42")).toEqual([
			expect.objectContaining({
				organizationProfileId: "org_1",
				organizationName: "OpenAI",
				organizationHandle: "OpenAI",
				isActive: true,
			}),
		]);

		expect(
			attachAffiliationsToProfiles(db, [
				{ id: "profile_aff_user_42", handle: "sam" },
				{ id: "profile_user_99", handle: "nobody" },
			]),
		).toEqual([
			expect.objectContaining({
				id: "profile_aff_user_42",
				primaryAffiliation: expect.objectContaining({
					organizationProfileId: "org_1",
				}),
			}),
			{ id: "profile_user_99", handle: "nobody" },
		]);
	});
});
