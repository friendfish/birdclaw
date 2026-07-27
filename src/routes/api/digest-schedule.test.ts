// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const installAllDigestArchiveLaunchAgentsEffectMock = vi.fn();

vi.mock("#/lib/digest-archive-job", async () => {
	const actual = await vi.importActual<
		typeof import("#/lib/digest-archive-job")
	>("#/lib/digest-archive-job");
	return {
		...actual,
		installAllDigestArchiveLaunchAgentsEffect: (...args: unknown[]) =>
			Effect.promise(() =>
				installAllDigestArchiveLaunchAgentsEffectMock(...args),
			),
	};
});

import { Route } from "./digest-schedule";
import { resetBirdclawPathsForTests } from "#/lib/config";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-digest-schedule-"),
	);
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
}

describe("api digest-schedule route", () => {
	beforeEach(() => {
		setupTempHome();
		installAllDigestArchiveLaunchAgentsEffectMock.mockReset();
		installAllDigestArchiveLaunchAgentsEffectMock.mockResolvedValue({
			today: { ok: true, result: {} },
			"24h": { ok: true, result: {} },
			yesterday: { ok: true, result: {} },
			week: { ok: true, result: {} },
		});
	});

	afterEach(() => {
		resetBirdclawPathsForTests();
		delete process.env.BIRDCLAW_HOME;
		for (const tempRoot of tempRoots.splice(0)) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("returns the default schedule when nothing has been configured", async () => {
		const response = await GET({
			request: new Request("http://localhost/api/digest-schedule"),
		});

		expect(await response.json()).toMatchObject({
			ok: true,
			schedule: {
				today: { hour: 8, minute: 0 },
				"24h": { hour: 8, minute: 45 },
				yesterday: { hour: 1, minute: 0 },
				week: { hour: 2, minute: 0, weekday: 1 },
			},
		});
	});

	it("saves the schedule and archive dir, then reinstalls all 4 launchd agents", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/digest-schedule", {
				method: "POST",
				body: JSON.stringify({
					archiveDir: "/tmp/my-archive",
					schedule: {
						today: { hour: 9, minute: 30 },
						"24h": { hour: 10, minute: 0 },
						yesterday: { hour: 2, minute: 0 },
						week: { hour: 3, minute: 15 },
					},
				}),
			}),
		});

		expect(installAllDigestArchiveLaunchAgentsEffectMock).toHaveBeenCalledWith({
			today: { hour: 9, minute: 30 },
			"24h": { hour: 10, minute: 0 },
			yesterday: { hour: 2, minute: 0 },
			week: { hour: 3, minute: 15, weekday: 1 },
		});
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			archiveDir: "/tmp/my-archive",
			schedule: {
				today: { hour: 9, minute: 30 },
				"24h": { hour: 10, minute: 0 },
				yesterday: { hour: 2, minute: 0 },
				week: { hour: 3, minute: 15, weekday: 1 },
			},
		});

		// The saved schedule persists across requests (reads from config.json,
		// not just an in-memory echo of what was posted).
		const getResponse = await GET({
			request: new Request("http://localhost/api/digest-schedule"),
		});
		expect(await getResponse.json()).toMatchObject({
			ok: true,
			archiveDir: "/tmp/my-archive",
			schedule: { today: { hour: 9, minute: 30 } },
		});
	});

	it("always forces week's weekday to Monday regardless of request body", async () => {
		await POST({
			request: new Request("http://localhost/api/digest-schedule", {
				method: "POST",
				body: JSON.stringify({
					schedule: {
						today: { hour: 8, minute: 0 },
						"24h": { hour: 8, minute: 45 },
						yesterday: { hour: 1, minute: 0 },
						week: { hour: 2, minute: 0 },
					},
				}),
			}),
		});

		const response = await GET({
			request: new Request("http://localhost/api/digest-schedule"),
		});
		expect((await response.json()).schedule.week).toEqual({
			hour: 2,
			minute: 0,
			weekday: 1,
		});
	});
});
