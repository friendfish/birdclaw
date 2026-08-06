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

	it("rejects incomplete or incompatible stable current rows", () => {
		const { db } = testHome();
		const valid = publishCurrentPeriodDigest(
			{
				period: "today",
				contentSource: "all",
				runId: "run-valid",
				versionId: "version-valid",
				generatedAt: "2026-08-06T08:30:00.000Z",
				result: result("Today", "all"),
				maxTweets: 5_000,
				maxLinks: 20,
				sync: { status: "fresh", steps: [] },
			},
			db,
		);
		const key = currentPeriodDigestKey("today", "all");
		const invalidRows: unknown[] = [
			null,
			[],
			{ ...valid, schemaVersion: 2 },
			{ ...valid, period: "week" },
			{ ...valid, contentSource: "unknown" },
			{ ...valid, runId: 1 },
			{ ...valid, versionId: 1 },
			{ ...valid, generatedAt: "not-a-date" },
			{ ...valid, context: null },
			{ ...valid, context: { ...valid.context, window: null } },
			{ ...valid, markdown: 1 },
			{ ...valid, model: 1 },
			{ ...valid, reasoningEffort: 1 },
			{ ...valid, serviceTier: 1 },
			{ ...valid, parseStatus: "invalid" },
			{ ...valid, input: null },
			{ ...valid, input: { ...valid.input, maxTweets: "5000" } },
			{ ...valid, input: { ...valid.input, maxLinks: "20" } },
			{ ...valid, sync: null },
			{ ...valid, digest: { title: "missing required fields" } },
		];

		for (const invalid of invalidRows) {
			writeSyncCache(key, invalid, db);
			expect(readCurrentPeriodDigest("today", "all", db)).toBeNull();
		}

		writeSyncCache(key, { ...valid, parseStatus: "fallback" }, db);
		expect(readCurrentPeriodDigest("today", "all", db)?.parseStatus).toBe(
			"fallback",
		);
	});

	it("diagnoses malformed legacy identities and supports legacy defaults", () => {
		const { db } = testHome();
		const writeLegacy = (key: string, value: unknown, writtenAt: string) =>
			writeSyncCache(
				key,
				value,
				db,
				createServerRuntimeServices({ now: () => new Date(writtenAt) }),
			);
		const base = result("Today", "all", "invalid-updated-at");
		const { contentSource: _contentSource, ...contextWithoutSource } =
			base.context;

		writeLegacy(
			"period-digest-latest:v1:default-source",
			{
				...base,
				context: contextWithoutSource,
				parseStatus: "fallback",
			},
			"2026-08-06T08:30:00.000Z",
		);
		writeLegacy(
			"period-digest-latest:v1:unknown-label",
			{ ...base, context: context("Yesterday", "all") },
			"2026-08-06T08:31:00.000Z",
		);
		writeLegacy(
			"period-digest-latest:v1:unknown-source",
			{
				...base,
				context: { ...context("Today", "all"), contentSource: "unknown" },
			},
			"2026-08-06T08:32:00.000Z",
		);
		writeLegacy(
			"period-digest-latest:v1:invalid-payload",
			{ context: null },
			"2026-08-06T08:33:00.000Z",
		);

		const migration = migrateLegacyPeriodDigests(db);

		expect(migration.migrated).toContainEqual({
			period: "today",
			contentSource: "all",
		});
		expect(migration.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "unknown-period-label" }),
				expect.objectContaining({ reason: "invalid-content-source" }),
				expect.objectContaining({ reason: "invalid-payload" }),
			]),
		);
		expect(readCurrentPeriodDigest("today", "all", db)).toMatchObject({
			generatedAt: "2026-08-06T08:30:00.000Z",
			parseStatus: "fallback",
		});
	});
});
