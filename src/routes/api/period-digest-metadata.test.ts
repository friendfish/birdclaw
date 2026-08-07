// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";
import type { CurrentPeriodDigestV1 } from "#/lib/period-digest-current-store";

vi.mock("#/lib/live-transport-policy", () => ({
	resolveLiveReadMode: () => "bird",
}));

const readCurrentPeriodDigestMock = vi.fn();
const migrateLegacyPeriodDigestsMock = vi.fn();
vi.mock("#/lib/period-digest-current-store", () => ({
	readCurrentPeriodDigest: (...args: unknown[]) =>
		readCurrentPeriodDigestMock(...args),
	migrateLegacyPeriodDigests: (...args: unknown[]) =>
		migrateLegacyPeriodDigestsMock(...args),
}));

const readPeriodDigestRunStateMock = vi.fn();
vi.mock("#/lib/period-digest-orchestrator", () => ({
	PERIOD_DIGEST_LOCK_STALE_MS: 60_000,
	periodDigestRunLockPath: (period: string) =>
		`/tmp/period-digest-${period}.lock`,
	readPeriodDigestRunState: (...args: unknown[]) =>
		readPeriodDigestRunStateMock(...args),
}));

const peekScheduledJobLockMock = vi.fn();
vi.mock("#/lib/scheduled-job", () => ({
	peekScheduledJobLockEffect: (...args: unknown[]) =>
		Effect.promise(() => peekScheduledJobLockMock(...args)),
}));

const isFreshDigestCacheMock = vi.fn();
vi.mock("#/lib/period-digest", () => ({
	normalizeDigestLanguage: (value: string | undefined) => value,
	normalizePeriod: (value: string | undefined) =>
		value === "24h" ? "24h" : "today",
	isFreshDigestCache: (...args: unknown[]) => isFreshDigestCacheMock(...args),
}));

import {
	resetPeriodDigestMetadataMigrationForTests,
	Route,
} from "./period-digest-metadata";

const GET = getRouteHandler(Route, "GET");
const STREAM_DIAGNOSTICS = {
	responseId: "resp-metadata",
	finishReason: "stop",
	visibleTextLength: 42,
	reasoningTextLength: 7,
};

function requestFor(period = "today", contentSource = "all") {
	return new Request(
		`http://localhost/api/period-digest-metadata?period=${period}&contentSource=${contentSource}`,
	);
}

function currentDigest(
	generatedAt = "2026-08-06T08:00:00.000Z",
	overrides: Partial<CurrentPeriodDigestV1> = {},
): CurrentPeriodDigestV1 {
	return {
		schemaVersion: 1,
		period: "today",
		contentSource: "all",
		runId: "run-old",
		versionId: "version-old",
		generatedAt,
		context: {
			window: {
				label: "Today",
				since: "2026-08-06T00:00:00.000Z",
				until: "2026-08-06T08:00:00.000Z",
			},
			includeDms: false,
			contentSource: "all",
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
			hash: "hash",
		},
		digest: {
			title: "Existing Today",
			summary: "A complete current digest",
			keyTopics: [],
			notableLinks: [],
			people: [],
			actionItems: [],
			sourceTweetIds: [],
		},
		markdown: "# Existing Today",
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		parseStatus: "structured",
		input: { maxTweets: 5_000, maxLinks: 20 },
		sync: { status: "fresh", steps: [] },
		...overrides,
	};
}

describe("api period-digest-metadata route", () => {
	beforeEach(() => {
		resetPeriodDigestMetadataMigrationForTests();
		readCurrentPeriodDigestMock.mockReset();
		migrateLegacyPeriodDigestsMock.mockReset();
		readPeriodDigestRunStateMock.mockReset();
		peekScheduledJobLockMock.mockReset();
		isFreshDigestCacheMock.mockReset();
		readCurrentPeriodDigestMock.mockReturnValue(currentDigest());
		readPeriodDigestRunStateMock.mockResolvedValue(undefined);
		peekScheduledJobLockMock.mockResolvedValue(false);
		isFreshDigestCacheMock.mockReturnValue(true);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("returns stale existing content while a replacement batch is running", async () => {
		isFreshDigestCacheMock.mockReturnValue(false);
		peekScheduledJobLockMock.mockResolvedValue(true);
		readPeriodDigestRunStateMock.mockResolvedValue({
			runId: "run-new",
			period: "today",
			phase: "generating",
			currentSource: "following",
			sourceOrder: ["all", "following", "for_you"],
			sources: {
				all: { state: "completed", attempts: 1 },
				following: { state: "running", attempts: 1 },
				for_you: { state: "pending", attempts: 0 },
			},
		});

		const response = await GET({ request: requestFor() });
		const body = await response.json();

		expect(body).toMatchObject({
			ok: true,
			isGenerating: true,
			isStale: true,
			activeStatus: {
				label: "Generating current digest",
				detail: "1/3 complete · Following",
			},
			result: {
				markdown: "# Existing Today",
				cached: true,
				updatedAt: "2026-08-06T08:00:00.000Z",
			},
			runState: { runId: "run-new", phase: "generating" },
		});
	});

	it("keeps the latest successful content after a failed batch", async () => {
		isFreshDigestCacheMock.mockReturnValue(false);
		readPeriodDigestRunStateMock.mockResolvedValue({
			runId: "run-failed",
			period: "today",
			phase: "failed",
			error: "model timeout",
			sourceOrder: ["all", "following", "for_you"],
			sources: {
				all: { state: "failed", attempts: 1, error: "model timeout" },
				following: { state: "failed", attempts: 1 },
				for_you: { state: "failed", attempts: 1 },
			},
		});

		const body = await (await GET({ request: requestFor() })).json();

		expect(body).toMatchObject({
			isGenerating: false,
			isStale: true,
			result: { markdown: "# Existing Today" },
			runState: { phase: "failed", error: "model timeout" },
		});
	});

	it("preserves valid stream diagnostics", async () => {
		readCurrentPeriodDigestMock.mockReturnValue(
			currentDigest(undefined, { diagnostics: STREAM_DIAGNOSTICS }),
		);

		const validBody = await (await GET({ request: requestFor() })).json();

		expect(validBody.result.diagnostics).toEqual(STREAM_DIAGNOSTICS);
	});

	it("omits invalid mocked stream diagnostics", async () => {
		readCurrentPeriodDigestMock.mockReturnValue(
			currentDigest(undefined, {
				diagnostics: {
					visibleTextLength: -1,
					reasoningTextLength: 7,
				} as never,
			}),
		);

		const invalidBody = await (await GET({ request: requestFor() })).json();

		expect(invalidBody.result).not.toHaveProperty("diagnostics");
	});

	it("returns null and stale when a mocked current digest has no displayable markdown", async () => {
		readCurrentPeriodDigestMock.mockReturnValue(
			currentDigest(undefined, { markdown: " \n\t" }),
		);
		migrateLegacyPeriodDigestsMock.mockReturnValue({
			migrated: [],
			diagnostics: [],
		});

		const body = await (await GET({ request: requestFor() })).json();

		expect(body).toMatchObject({
			result: null,
			isStale: true,
		});
		expect(migrateLegacyPeriodDigestsMock).toHaveBeenCalledTimes(1);
		expect(isFreshDigestCacheMock).not.toHaveBeenCalled();
	});

	it("returns a valid digest recovered by legacy migration", async () => {
		let current: CurrentPeriodDigestV1 | null = null;
		readCurrentPeriodDigestMock.mockImplementation(() => current);
		migrateLegacyPeriodDigestsMock.mockImplementation(() => {
			current = currentDigest("2026-08-06T07:00:00.000Z");
			return {
				migrated: [{ period: "today", contentSource: "all" }],
				diagnostics: [],
			};
		});

		const body = await (await GET({ request: requestFor() })).json();

		expect(migrateLegacyPeriodDigestsMock).toHaveBeenCalledTimes(1);
		expect(body.result).toMatchObject({
			markdown: "# Existing Today",
			updatedAt: "2026-08-06T07:00:00.000Z",
		});
	});

	it("retries legacy recovery after a transient migration failure", async () => {
		let current: CurrentPeriodDigestV1 | null = null;
		readCurrentPeriodDigestMock.mockImplementation(() => current);
		migrateLegacyPeriodDigestsMock
			.mockImplementationOnce(() => {
				throw new Error("transient SQLite error");
			})
			.mockImplementationOnce(() => {
				current = currentDigest("2026-08-06T07:00:00.000Z");
				return {
					migrated: [{ period: "today", contentSource: "all" }],
					diagnostics: [],
				};
			});

		await expect(GET({ request: requestFor() })).rejects.toThrow(
			"transient SQLite error",
		);
		const recovered = await (await GET({ request: requestFor() })).json();

		expect(migrateLegacyPeriodDigestsMock).toHaveBeenCalledTimes(2);
		expect(recovered.result).toMatchObject({
			markdown: "# Existing Today",
			updatedAt: "2026-08-06T07:00:00.000Z",
		});
	});

	it("runs legacy recovery once per invalid episode and retries after valid content", async () => {
		let current: CurrentPeriodDigestV1 | null = null;
		readCurrentPeriodDigestMock.mockImplementation(() => current);
		migrateLegacyPeriodDigestsMock.mockReturnValue({
			migrated: [],
			diagnostics: [],
		});

		await GET({ request: requestFor() });
		await GET({ request: requestFor() });
		expect(migrateLegacyPeriodDigestsMock).toHaveBeenCalledTimes(1);

		current = currentDigest();
		await GET({ request: requestFor() });
		current = null;
		await GET({ request: requestFor() });

		expect(migrateLegacyPeriodDigestsMock).toHaveBeenCalledTimes(2);
	});

	it("throttles legacy recovery independently per period and content source", async () => {
		readCurrentPeriodDigestMock.mockReturnValue(null);
		migrateLegacyPeriodDigestsMock.mockReturnValue({
			migrated: [],
			diagnostics: [],
		});

		await GET({ request: requestFor("today", "all") });
		await GET({ request: requestFor("today", "all") });
		await GET({ request: requestFor("24h", "following") });
		await GET({ request: requestFor("24h", "following") });

		expect(migrateLegacyPeriodDigestsMock).toHaveBeenCalledTimes(2);
	});
});
