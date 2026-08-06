// @vitest-environment node
import { describe, expect, it } from "vitest";
import { useTestHome } from "../test/test-home";
import type {
	PeriodDigestContentSource,
	PeriodDigestContext,
	PeriodDigestRunResult,
} from "./period-digest";
import {
	currentPeriodDigestKey,
	migrateLegacyPeriodDigests,
	publishCurrentPeriodDigest,
	readCurrentPeriodDigest,
} from "./period-digest-current-store";
import { createServerRuntimeServices } from "./server-runtime-services";
import { writeSyncCache } from "./sync-cache";

const testHome = useTestHome({ prefix: "birdclaw-current-digest-" });

function context(
	label: string,
	contentSource: PeriodDigestContentSource,
	includeDms = false,
): PeriodDigestContext {
	return {
		window: {
			label,
			since: "2026-08-06T00:00:00.000Z",
			until: "2026-08-06T08:00:00.000Z",
		},
		includeDms,
		contentSource,
		counts: {
			home: 0,
			mentions: 0,
			authored: 0,
			likes: 0,
			bookmarks: 0,
			dms: 0,
			links: 0,
		},
		tweets: [],
		dms: [],
		links: [],
		hash: `${label}:${contentSource}:${String(includeDms)}`,
	};
}

function result(
	label: string,
	contentSource: PeriodDigestContentSource,
	updatedAt = "2026-08-06T08:30:00.000Z",
	includeDms = false,
): PeriodDigestRunResult {
	return {
		context: context(label, contentSource, includeDms),
		digest: {
			title: `${label} ${contentSource}`,
			summary: "A complete digest",
			keyTopics: [],
			notableLinks: [],
			people: [],
			actionItems: [],
			sourceTweetIds: [],
		},
		markdown: `# ${label} ${contentSource}`,
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		parseStatus: "structured",
		cached: false,
		updatedAt,
	};
}

describe("current period digest store", () => {
	it("uses only period and content source as the current-view identity", () => {
		expect(currentPeriodDigestKey("today", "all")).toBe(
			"period-digest-current:v1:today:all",
		);
		expect(currentPeriodDigestKey("24h", "for_you")).toBe(
			"period-digest-current:v1:24h:for_you",
		);
	});

	it("atomically replaces a complete source version", () => {
		const { db } = testHome();
		const first = publishCurrentPeriodDigest(
			{
				period: "today",
				contentSource: "following",
				runId: "run-1",
				versionId: "version-1",
				generatedAt: "2026-08-06T08:30:00.000Z",
				result: result("Today", "following"),
				language: "zh-CN",
				promptHash: "prompt-1",
				maxTweets: 5_000,
				maxLinks: 20,
				sync: { status: "fresh", steps: [] },
			},
			db,
		);

		expect(first).toMatchObject({
			schemaVersion: 1,
			period: "today",
			contentSource: "following",
			versionId: "version-1",
			generatedAt: "2026-08-06T08:30:00.000Z",
			markdown: "# Today following",
			language: "zh-CN",
			input: { maxTweets: 5_000, maxLinks: 20 },
		});

		publishCurrentPeriodDigest(
			{
				period: "today",
				contentSource: "following",
				runId: "run-2",
				versionId: "version-2",
				generatedAt: "2026-08-06T09:45:00.000Z",
				result: {
					...result("Today", "following", "2026-08-06T09:45:00.000Z"),
					markdown: "# Replacement",
				},
				promptHash: "prompt-2",
				maxTweets: 2_500,
				maxLinks: 12,
				sync: { status: "degraded", steps: [] },
			},
			db,
		);

		expect(readCurrentPeriodDigest("today", "following", db)).toMatchObject({
			versionId: "version-2",
			runId: "run-2",
			markdown: "# Replacement",
			sync: { status: "degraded" },
		});
	});

	it("migrates the newest valid no-DM legacy row for each logical page", () => {
		const { db } = testHome();
		const runtime = createServerRuntimeServices({
			now: () => new Date("2026-08-06T10:00:00.000Z"),
		});
		const writeLegacy = (
			key: string,
			value: PeriodDigestRunResult,
			writtenAt: string,
		) => {
			writeSyncCache(
				key,
				{
					context: value.context,
					digest: value.digest,
					markdown: value.markdown,
					model: value.model,
					reasoningEffort: value.reasoningEffort,
					serviceTier: value.serviceTier,
					parseStatus: value.parseStatus,
					updatedAt: value.updatedAt,
				},
				db,
				createServerRuntimeServices({ now: () => new Date(writtenAt) }),
			);
		};

		writeLegacy(
			"period-digest-latest:v1:today-old",
			result("Today", "all", "2026-08-06T07:00:00.000Z"),
			"2026-08-06T07:00:01.000Z",
		);
		writeLegacy(
			"period-digest-latest:v1:today-new",
			result("Today", "all", "2026-08-06T08:30:00.000Z"),
			"2026-08-06T08:30:01.000Z",
		);
		writeLegacy(
			"period-digest-latest:v1:24h",
			result("Last 24 hours", "for_you", "2026-08-06T08:40:00.000Z"),
			"2026-08-06T08:40:01.000Z",
		);
		writeLegacy(
			"period-digest-latest:v1:dms",
			result("Today", "following", "2026-08-06T09:00:00.000Z", true),
			"2026-08-06T09:00:01.000Z",
		);
		db.prepare(
			"insert into sync_cache (cache_key, value_json, updated_at) values (?, ?, ?)",
		).run(
			"period-digest-latest:v1:corrupt",
			"{not-json",
			"2026-08-06T09:30:00.000Z",
		);

		const migration = migrateLegacyPeriodDigests(db, runtime);

		expect(migration.migrated).toHaveLength(2);
		expect(migration.migrated).toEqual(
			expect.arrayContaining([
				{ period: "today", contentSource: "all" },
				{ period: "24h", contentSource: "for_you" },
			]),
		);
		expect(migration.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "dm-content-not-supported" }),
				expect.objectContaining({ reason: "invalid-json" }),
			]),
		);
		expect(readCurrentPeriodDigest("today", "all", db)).toMatchObject({
			generatedAt: "2026-08-06T08:30:00.000Z",
			markdown: "# Today all",
			migratedFromLegacy: true,
		});
		expect(readCurrentPeriodDigest("24h", "for_you", db)).toMatchObject({
			generatedAt: "2026-08-06T08:40:00.000Z",
			migratedFromLegacy: true,
		});
		expect(readCurrentPeriodDigest("today", "following", db)).toBeNull();
	});

	it("never overwrites a stable row during legacy migration", () => {
		const { db } = testHome();
		publishCurrentPeriodDigest(
			{
				period: "today",
				contentSource: "all",
				runId: "stable-run",
				versionId: "stable-version",
				generatedAt: "2026-08-06T06:00:00.000Z",
				result: result("Today", "all", "2026-08-06T06:00:00.000Z"),
				maxTweets: 2_500,
				maxLinks: 12,
				sync: { status: "fresh", steps: [] },
			},
			db,
		);
		writeSyncCache(
			"period-digest-latest:v1:newer",
			{
				...result("Today", "all", "2026-08-06T09:00:00.000Z"),
				context: context("Today", "all"),
			},
			db,
		);

		migrateLegacyPeriodDigests(db);

		expect(readCurrentPeriodDigest("today", "all", db)).toMatchObject({
			versionId: "stable-version",
			runId: "stable-run",
		});
	});
});
