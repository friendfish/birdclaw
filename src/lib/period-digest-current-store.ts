import { createHash } from "node:crypto";
import {
	periodDigestSchema,
	type PeriodDigest,
} from "./analysis-result-contracts";
import { getNativeDb } from "./db";
import type { DigestArchiveSyncResult } from "./digest-archive-sync";
import type {
	PeriodDigestContentSource,
	PeriodDigestContext,
	PeriodDigestRunResult,
} from "./period-digest";
import {
	defaultServerRuntimeServices,
	type ServerRuntimeServices,
} from "./server-runtime-services";
import type { Database } from "./sqlite";
import { readSyncCache, writeSyncCache } from "./sync-cache";

export type CurrentPeriodDigestPeriod = "today" | "24h";

export interface CurrentPeriodDigestV1 {
	schemaVersion: 1;
	period: CurrentPeriodDigestPeriod;
	contentSource: PeriodDigestContentSource;
	runId: string;
	versionId: string;
	generatedAt: string;
	context: PeriodDigestContext;
	digest: PeriodDigest;
	markdown: string;
	model: string;
	language?: string;
	promptHash?: string;
	reasoningEffort: string;
	serviceTier: string;
	parseStatus: "structured" | "fallback";
	input: {
		maxTweets: number;
		maxLinks: number;
	};
	sync: DigestArchiveSyncResult;
	migratedFromLegacy?: boolean;
}

export interface PublishCurrentPeriodDigestInput {
	period: CurrentPeriodDigestPeriod;
	contentSource: PeriodDigestContentSource;
	runId: string;
	versionId: string;
	generatedAt: string;
	result: PeriodDigestRunResult;
	language?: string;
	promptHash?: string;
	maxTweets: number;
	maxLinks: number;
	sync: DigestArchiveSyncResult;
	migratedFromLegacy?: boolean;
}

export type LegacyDigestMigrationReason =
	| "invalid-json"
	| "invalid-payload"
	| "unknown-period-label"
	| "invalid-content-source"
	| "dm-content-not-supported"
	| "stable-result-exists";

export interface LegacyDigestMigrationDiagnostic {
	cacheKey: string;
	reason: LegacyDigestMigrationReason;
}

export interface LegacyDigestMigrationResult {
	migrated: Array<{
		period: CurrentPeriodDigestPeriod;
		contentSource: PeriodDigestContentSource;
	}>;
	diagnostics: LegacyDigestMigrationDiagnostic[];
}

export const LEGACY_PERIOD_LABELS: Readonly<
	Record<string, CurrentPeriodDigestPeriod>
> = Object.freeze({
	Today: "today",
	"Last 24 hours": "24h",
});

const CONTENT_SOURCES = new Set<PeriodDigestContentSource>([
	"all",
	"following",
	"for_you",
]);

interface LegacySyncCacheRow {
	cache_key: string;
	value_json: string;
	updated_at: string;
}

interface LegacyDigestCandidate {
	cacheKey: string;
	period: CurrentPeriodDigestPeriod;
	contentSource: PeriodDigestContentSource;
	generatedAt: string;
	result: PeriodDigestRunResult;
}

export function currentPeriodDigestKey(
	period: CurrentPeriodDigestPeriod,
	contentSource: PeriodDigestContentSource,
) {
	return `period-digest-current:v1:${period}:${contentSource}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isContentSource(value: unknown): value is PeriodDigestContentSource {
	return typeof value === "string" && CONTENT_SOURCES.has(value as never);
}

function isPeriodDigestContext(value: unknown): value is PeriodDigestContext {
	if (!isRecord(value) || !isRecord(value.window)) return false;
	return (
		typeof value.window.label === "string" &&
		isIsoTimestamp(value.window.since) &&
		isIsoTimestamp(value.window.until) &&
		typeof value.includeDms === "boolean" &&
		(value.contentSource === undefined ||
			isContentSource(value.contentSource)) &&
		isRecord(value.counts) &&
		Array.isArray(value.tweets) &&
		Array.isArray(value.dms) &&
		Array.isArray(value.links) &&
		typeof value.hash === "string"
	);
}

function parseCurrentPeriodDigest(
	value: unknown,
): CurrentPeriodDigestV1 | null {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		(value.period !== "today" && value.period !== "24h") ||
		!isContentSource(value.contentSource) ||
		typeof value.runId !== "string" ||
		typeof value.versionId !== "string" ||
		!isIsoTimestamp(value.generatedAt) ||
		!isPeriodDigestContext(value.context) ||
		typeof value.markdown !== "string" ||
		typeof value.model !== "string" ||
		typeof value.reasoningEffort !== "string" ||
		typeof value.serviceTier !== "string" ||
		(value.parseStatus !== "structured" && value.parseStatus !== "fallback") ||
		!isRecord(value.input) ||
		typeof value.input.maxTweets !== "number" ||
		typeof value.input.maxLinks !== "number" ||
		!isRecord(value.sync)
	) {
		return null;
	}
	const digest = periodDigestSchema.safeParse(value.digest);
	if (!digest.success) return null;
	return { ...value, digest: digest.data } as unknown as CurrentPeriodDigestV1;
}

export function publishCurrentPeriodDigest(
	input: PublishCurrentPeriodDigestInput,
	db: Database = getNativeDb(),
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): CurrentPeriodDigestV1 {
	const value: CurrentPeriodDigestV1 = {
		schemaVersion: 1,
		period: input.period,
		contentSource: input.contentSource,
		runId: input.runId,
		versionId: input.versionId,
		generatedAt: input.generatedAt,
		context: input.result.context,
		digest: input.result.digest,
		markdown: input.result.markdown,
		model: input.result.model,
		...(input.language ? { language: input.language } : {}),
		...(input.promptHash ? { promptHash: input.promptHash } : {}),
		reasoningEffort: input.result.reasoningEffort,
		serviceTier: input.result.serviceTier,
		parseStatus: input.result.parseStatus,
		input: {
			maxTweets: input.maxTweets,
			maxLinks: input.maxLinks,
		},
		sync: input.sync,
		...(input.migratedFromLegacy ? { migratedFromLegacy: true } : {}),
	};
	writeSyncCache(
		currentPeriodDigestKey(input.period, input.contentSource),
		value,
		db,
		runtime,
	);
	return value;
}

export function readCurrentPeriodDigest(
	period: CurrentPeriodDigestPeriod,
	contentSource: PeriodDigestContentSource,
	db: Database = getNativeDb(),
): CurrentPeriodDigestV1 | null {
	const cached = readSyncCache<unknown>(
		currentPeriodDigestKey(period, contentSource),
		db,
	);
	return cached ? parseCurrentPeriodDigest(cached.value) : null;
}

function parseLegacyCandidate(
	row: LegacySyncCacheRow,
):
	| { candidate: LegacyDigestCandidate }
	| { reason: LegacyDigestMigrationReason } {
	let value: unknown;
	try {
		value = JSON.parse(row.value_json);
	} catch {
		return { reason: "invalid-json" };
	}
	if (!isRecord(value) || !isRecord(value.context)) {
		return { reason: "invalid-payload" };
	}
	const contentSource = value.context.contentSource ?? "all";
	if (!isContentSource(contentSource)) {
		return { reason: "invalid-content-source" };
	}
	if (!isPeriodDigestContext(value.context)) {
		return { reason: "invalid-payload" };
	}
	if (value.context.includeDms) {
		return { reason: "dm-content-not-supported" };
	}
	const period = LEGACY_PERIOD_LABELS[value.context.window.label];
	if (!period) return { reason: "unknown-period-label" };
	const digest = periodDigestSchema.safeParse(value.digest);
	const generatedAt = isIsoTimestamp(value.updatedAt)
		? value.updatedAt
		: isIsoTimestamp(row.updated_at)
			? row.updated_at
			: null;
	if (
		!digest.success ||
		!generatedAt ||
		typeof value.markdown !== "string" ||
		typeof value.model !== "string" ||
		typeof value.reasoningEffort !== "string" ||
		typeof value.serviceTier !== "string" ||
		(value.parseStatus !== "structured" && value.parseStatus !== "fallback")
	) {
		return { reason: "invalid-payload" };
	}
	return {
		candidate: {
			cacheKey: row.cache_key,
			period,
			contentSource,
			generatedAt,
			result: {
				context: value.context,
				digest: digest.data,
				markdown: value.markdown,
				model: value.model,
				reasoningEffort: value.reasoningEffort,
				serviceTier: value.serviceTier,
				parseStatus: value.parseStatus,
				cached: true,
				updatedAt: generatedAt,
			},
		},
	};
}

export function migrateLegacyPeriodDigests(
	db: Database = getNativeDb(),
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): LegacyDigestMigrationResult {
	const rows = db
		.prepare(
			`select cache_key, value_json, updated_at
			 from sync_cache
			 where cache_key like 'period-digest-latest:%'
			 order by updated_at desc`,
		)
		.all() as LegacySyncCacheRow[];
	const diagnostics: LegacyDigestMigrationDiagnostic[] = [];
	const newest = new Map<string, LegacyDigestCandidate>();

	for (const row of rows) {
		const parsed = parseLegacyCandidate(row);
		if ("reason" in parsed) {
			diagnostics.push({ cacheKey: row.cache_key, reason: parsed.reason });
			continue;
		}
		const logicalKey = currentPeriodDigestKey(
			parsed.candidate.period,
			parsed.candidate.contentSource,
		);
		const current = newest.get(logicalKey);
		if (
			!current ||
			Date.parse(parsed.candidate.generatedAt) > Date.parse(current.generatedAt)
		) {
			newest.set(logicalKey, parsed.candidate);
		}
	}

	const migrated: LegacyDigestMigrationResult["migrated"] = [];
	for (const [logicalKey, candidate] of newest) {
		if (readSyncCache(logicalKey, db)) {
			diagnostics.push({
				cacheKey: candidate.cacheKey,
				reason: "stable-result-exists",
			});
			continue;
		}
		const versionId = `legacy-${createHash("sha1")
			.update(`${candidate.cacheKey}:${candidate.generatedAt}`)
			.digest("hex")}`;
		publishCurrentPeriodDigest(
			{
				period: candidate.period,
				contentSource: candidate.contentSource,
				runId: "legacy-migration",
				versionId,
				generatedAt: candidate.generatedAt,
				result: candidate.result,
				maxTweets: 2_500,
				maxLinks: 12,
				sync: { status: "skipped", steps: [] },
				migratedFromLegacy: true,
			},
			db,
			runtime,
		);
		migrated.push({
			period: candidate.period,
			contentSource: candidate.contentSource,
		});
	}
	return { migrated, diagnostics };
}
