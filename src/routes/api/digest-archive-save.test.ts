// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const mocks = vi.hoisted(() => ({
	resolveDigestArchiveDir: vi.fn(),
	peekScheduledJobLockMetadataEffect: vi.fn(),
	readLatestPeriodDigestEffect: vi.fn(),
	replaceDigestArchiveEntryEffect: vi.fn(),
	appendScheduledJobAuditEffect: vi.fn(),
}));

vi.mock("#/lib/config", () => ({
	resolveDigestArchiveDir: (...args: unknown[]) =>
		mocks.resolveDigestArchiveDir(...args),
}));
vi.mock("#/lib/digest-archive-job", () => ({
	DEFAULT_LOCK_STALE_MS: 60_000,
	digestArchiveLockPath: (period: string) => `/tmp/${period}.lock`,
	formatDigestArchiveRunDate: () => "2026-08-04",
	getDefaultDigestArchiveAuditLogPath: () => "/tmp/manual-save.jsonl",
	replaceDigestArchiveEntryEffect: (...args: unknown[]) =>
		Effect.promise(() => mocks.replaceDigestArchiveEntryEffect(...args)),
	resolveDigestArchiveLanguage: () => "zh-CN",
}));
vi.mock("#/lib/period-digest", () => ({
	readLatestPeriodDigestEffect: (...args: unknown[]) =>
		Effect.promise(() => mocks.readLatestPeriodDigestEffect(...args)),
}));
vi.mock("#/lib/scheduled-job", () => ({
	peekScheduledJobLockMetadataEffect: (...args: unknown[]) =>
		Effect.promise(() => mocks.peekScheduledJobLockMetadataEffect(...args)),
	appendScheduledJobAuditEffect: (...args: unknown[]) =>
		Effect.promise(() => mocks.appendScheduledJobAuditEffect(...args)),
}));

import { Route } from "./digest-archive-save";

const POST = getRouteHandler(Route, "POST");

function request(body: unknown) {
	return new Request("http://localhost/api/digest-archive-save", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const validBody = {
	period: "today",
	contentSource: "following",
	includeDms: false,
	expectedUpdatedAt: "2026-08-04T01:23:45.000Z",
};

const cachedResult = {
	context: { window: { label: "Today" } },
	digest: { title: "Current" },
	markdown: "# Current",
	model: "gpt-5.5",
	reasoningEffort: "medium",
	serviceTier: "priority",
	parseStatus: "structured",
	cached: true,
	updatedAt: validBody.expectedUpdatedAt,
};

describe("api digest-archive-save route", () => {
	beforeEach(() => {
		for (const mock of Object.values(mocks)) mock.mockReset();
		mocks.resolveDigestArchiveDir.mockReturnValue("/tmp/archive");
		mocks.peekScheduledJobLockMetadataEffect.mockResolvedValue(undefined);
		mocks.appendScheduledJobAuditEffect.mockResolvedValue(undefined);
	});

	it.each(["yesterday", "week"])("rejects the %s period", async (period) => {
		const response = await POST({
			request: request({ ...validBody, period }),
		});

		expect(response.status).toBe(400);
		expect(mocks.readLatestPeriodDigestEffect).not.toHaveBeenCalled();
		expect(mocks.replaceDigestArchiveEntryEffect).not.toHaveBeenCalled();
	});

	it("rejects saving when no complete server-side cache exists", async () => {
		mocks.readLatestPeriodDigestEffect.mockResolvedValue(null);

		const response = await POST({ request: request(validBody) });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			ok: false,
			error: "No complete manually generated digest is available to save.",
		});
		expect(mocks.replaceDigestArchiveEntryEffect).not.toHaveBeenCalled();
	});

	it("rejects a stale displayed result timestamp", async () => {
		mocks.readLatestPeriodDigestEffect.mockResolvedValue({
			...cachedResult,
			updatedAt: "2026-08-04T01:24:00.000Z",
		});

		const response = await POST({ request: request(validBody) });

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			error:
				"The displayed digest is no longer the latest result. Refresh and try again.",
		});
		expect(mocks.replaceDigestArchiveEntryEffect).not.toHaveBeenCalled();
	});

	it("rejects saving while a scheduled job owns the same period", async () => {
		mocks.peekScheduledJobLockMetadataEffect.mockResolvedValue({
			pid: 42,
			host: "clawmac",
			startedAt: "2026-08-04T00:00:00.000Z",
		});

		const response = await POST({ request: request(validBody) });

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			error: "A scheduled digest is currently generating for this period.",
		});
		expect(mocks.readLatestPeriodDigestEffect).not.toHaveBeenCalled();
	});

	it("replaces one archive from the exact server cache and records an audit", async () => {
		mocks.readLatestPeriodDigestEffect.mockResolvedValue(cachedResult);
		mocks.replaceDigestArchiveEntryEffect.mockResolvedValue({
			period: "today",
			contentSource: "following",
			runDate: "2026-08-04",
			generatedAt: validBody.expectedUpdatedAt,
			savedAt: "2026-08-04T02:00:00.000Z",
			markdownPath: "/tmp/archive/2026-08-04/today-following.md",
			jsonPath: "/tmp/archive/2026-08-04/today-following.json",
		});

		const response = await POST({ request: request(validBody) });

		expect(mocks.peekScheduledJobLockMetadataEffect).toHaveBeenCalledWith(
			"/tmp/today.lock",
			60_000,
		);
		expect(mocks.readLatestPeriodDigestEffect).toHaveBeenCalledWith({
			period: "today",
			contentSource: "following",
			includeDms: false,
		});
		expect(mocks.replaceDigestArchiveEntryEffect).toHaveBeenCalledWith({
			archiveDir: "/tmp/archive",
			runDate: "2026-08-04",
			period: "today",
			contentSource: "following",
			result: cachedResult,
			language: "zh-CN",
		});
		expect(mocks.appendScheduledJobAuditEffect).toHaveBeenCalledWith(
			"/tmp/manual-save.jsonl",
			expect.objectContaining({
				job: "digest-archive-manual-save",
				period: "today",
				contentSource: "following",
				generatedAt: validBody.expectedUpdatedAt,
				savedAt: "2026-08-04T02:00:00.000Z",
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			period: "today",
			contentSource: "following",
			generatedAt: validBody.expectedUpdatedAt,
			savedAt: "2026-08-04T02:00:00.000Z",
		});
	});
});
