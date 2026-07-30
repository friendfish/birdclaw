// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "#/lib/config";
import { resetDatabaseForTests } from "#/lib/db";
import { getRouteHandler } from "#/test/route-handlers";

const mocks = vi.hoisted(() => ({
	maybeAutoUpdateBackup: vi.fn(),
	getQueryEnvelope: vi.fn(),
	getTransportStatus: vi.fn(),
	useActualQueryStatus: false,
}));

vi.mock("#/lib/backup", () => ({
	maybeAutoUpdateBackup: mocks.maybeAutoUpdateBackup,
	maybeAutoUpdateBackupEffect: () =>
		Effect.promise(() => Promise.resolve(mocks.maybeAutoUpdateBackup())),
}));

vi.mock("#/lib/xurl", () => ({
	getTransportStatusEffect: () =>
		Effect.promise(() => Promise.resolve(mocks.getTransportStatus())),
}));

vi.mock("#/lib/query-status", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/query-status")>();
	return {
		...actual,
		getQueryEnvelope: (...args: Parameters<typeof actual.getQueryEnvelope>) =>
			mocks.useActualQueryStatus
				? actual.getQueryEnvelope(...args)
				: mocks.getQueryEnvelope(...args),
		getQueryEnvelopeEffect: (
			...args: Parameters<typeof actual.getQueryEnvelopeEffect>
		) =>
			mocks.useActualQueryStatus
				? actual.getQueryEnvelopeEffect(...args)
				: Effect.promise(() => Promise.resolve(mocks.getQueryEnvelope())),
	};
});

import { Route } from "./status";

const GET = getRouteHandler(Route, "GET");

describe("status api route", () => {
	const tempRoots: string[] = [];

	afterEach(() => {
		resetDatabaseForTests();
		for (const root of tempRoots) {
			rmSync(root, { recursive: true, force: true });
		}
		tempRoots.length = 0;
		mocks.useActualQueryStatus = false;
		mocks.getTransportStatus.mockReset();
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		delete process.env.BIRDCLAW_LIVE_DATA_SOURCE;
	});

	it("returns the query envelope as json", async () => {
		mocks.maybeAutoUpdateBackup.mockResolvedValue(undefined);
		mocks.getQueryEnvelope.mockResolvedValue({
			stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
			accounts: [
				{
					id: "acct_primary",
					name: "Primary",
					handle: "@primary",
					transport: "xurl",
					isDefault: 1,
					createdAt: "2026-06-15T12:00:00.000Z",
				},
			],
			archives: [
				{
					path: "/tmp/archive.zip",
					name: "archive.zip",
					size: 1024,
					sizeFormatted: "1 KB",
					modifiedTime: "2026-06-15T12:00:00.000Z",
					dateFormatted: "Jun 15, 2026",
				},
			],
			transport: {
				installed: true,
				availableTransport: "xurl",
				statusText: "xurl available",
			},
		});

		const response = await GET({
			request: new Request("http://localhost/api/status"),
		});

		await expect(response.json()).resolves.toEqual({
			stats: {
				home: 4,
				homeForYou: 0,
				homeFollowing: 0,
				mentions: 2,
				dms: 4,
				needsReply: 2,
				inbox: 4,
			},
			accounts: [
				{
					id: "acct_primary",
					name: "Primary",
					handle: "@primary",
					transport: "xurl",
					isDefault: 1,
					createdAt: "2026-06-15T12:00:00.000Z",
				},
			],
			archives: [
				{
					path: "/tmp/archive.zip",
					name: "archive.zip",
					size: 1024,
					sizeFormatted: "1 KB",
					modifiedTime: "2026-06-15T12:00:00.000Z",
					dateFormatted: "Jun 15, 2026",
				},
			],
			transport: {
				installed: true,
				availableTransport: "xurl",
				statusText: "xurl available",
			},
		});
		expect(mocks.maybeAutoUpdateBackup).toHaveBeenCalledTimes(1);
		expect(response.headers.get("content-type")).toBe("application/json");
	});

	it("omits installed from disabled xurl status without probing xurl", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "birdclaw-status-route-"));
		tempRoots.push(root);
		process.env.BIRDCLAW_HOME = root;
		process.env.BIRDCLAW_LIVE_DATA_SOURCE = "bird";
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		mocks.useActualQueryStatus = true;
		mocks.maybeAutoUpdateBackup.mockResolvedValue(undefined);

		const response = await GET({
			request: new Request("http://localhost/api/status"),
		});

		const payload = await response.json();
		expect(payload).toMatchObject({
			transport: {
				availableTransport: "local",
				statusText: "xurl disabled by bird transport selection",
			},
		});
		expect(payload).not.toHaveProperty("transport.installed");
		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
	});
});
