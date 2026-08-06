// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

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

import { Route } from "./period-digest-metadata";

const GET = getRouteHandler(Route, "GET");

function requestFor(period = "today", contentSource = "all") {
	return new Request(
		`http://localhost/api/period-digest-metadata?period=${period}&contentSource=${contentSource}`,
	);
}

function currentDigest(generatedAt = "2026-08-06T08:00:00.000Z") {
	return {
		schemaVersion: 1,
		period: "today",
		contentSource: "all",
		runId: "run-old",
		versionId: "version-old",
		generatedAt,
		context: {
			window: { label: "Today", since: "s", until: "u" },
			includeDms: false,
			contentSource: "all",
			counts: {},
			tweets: [],
			dms: [],
			links: [],
			hash: "hash",
		},
		digest: { actionItems: [] },
		markdown: "# Existing Today",
		model: "gpt-5.5",
		reasoningEffort: "medium",
		serviceTier: "priority",
		parseStatus: "structured",
		input: { maxTweets: 5_000, maxLinks: 20 },
		sync: { status: "fresh", steps: [] },
	};
}

describe("api period-digest-metadata route", () => {
	beforeEach(() => {
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

	it("runs the one-time legacy migration before returning an empty first-use state", async () => {
		readCurrentPeriodDigestMock
			.mockReturnValueOnce(null)
			.mockReturnValueOnce(currentDigest("2026-08-06T07:00:00.000Z"))
			.mockReturnValueOnce(null)
			.mockReturnValueOnce(currentDigest("2026-08-06T07:00:00.000Z"));
		migrateLegacyPeriodDigestsMock.mockReturnValue({
			migrated: [{ period: "today", contentSource: "all" }],
			diagnostics: [],
		});

		const body = await (await GET({ request: requestFor() })).json();
		const second = await (await GET({ request: requestFor() })).json();

		expect(migrateLegacyPeriodDigestsMock).toHaveBeenCalledTimes(1);
		expect(readCurrentPeriodDigestMock).toHaveBeenCalledTimes(4);
		expect(body.result).toMatchObject({
			markdown: "# Existing Today",
			updatedAt: "2026-08-06T07:00:00.000Z",
		});
		expect(second.result).toMatchObject({
			markdown: "# Existing Today",
			updatedAt: "2026-08-06T07:00:00.000Z",
		});
	});
});
