// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const installAllDigestArchiveLaunchAgentsEffectMock = vi.fn();
const reconcileAllPeriodDigestFreshnessMock = vi.fn();

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

vi.mock("#/lib/period-digest-freshness", async () => {
	const actual = await vi.importActual<
		typeof import("#/lib/period-digest-freshness")
	>("#/lib/period-digest-freshness");
	return {
		...actual,
		reconcileAllPeriodDigestFreshness: (...args: unknown[]) =>
			reconcileAllPeriodDigestFreshnessMock(...args),
	};
});

import { Route } from "./digest-schedule";
import { resetBirdclawPathsForTests, writeBirdclawConfig } from "#/lib/config";
import { getBirdCredentialsPath } from "#/lib/bird-credentials";
import { periodDigestRunStatePath } from "#/lib/period-digest-orchestrator";

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
		reconcileAllPeriodDigestFreshnessMock.mockReset();
		reconcileAllPeriodDigestFreshnessMock.mockResolvedValue({
			today: {
				state: { status: "scheduled", dueAt: "2026-08-06T20:00:00.000Z" },
				installResult: { ok: true },
			},
			"24h": {
				state: { status: "disabled", dueAt: "" },
				installResult: null,
			},
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
			freshnessHours: 12,
			schedule: {
				today: { hour: 8, minute: 0 },
				"24h": { hour: 8, minute: 45 },
				yesterday: { hour: 1, minute: 0 },
				week: { hour: 2, minute: 0, weekday: 1 },
			},
		});
	});

	it("does not expose extra diagnostics from persisted digest runs", async () => {
		const statePath = periodDigestRunStatePath("today");
		mkdirSync(path.dirname(statePath), { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify({
				schemaVersion: 1,
				runId: "legacy-route-run",
				period: "today",
				startedBy: { trigger: "scheduled", origin: "launchd" },
				joinedBy: [],
				sourceOrder: ["all", "following", "for_you"],
				ownerId: "legacy-owner",
				pid: 123,
				host: "legacy-host",
				startedAt: "2026-08-06T08:00:00.000Z",
				heartbeatAt: "2026-08-06T08:05:00.000Z",
				phase: "degraded",
				sources: {
					all: {
						state: "completed",
						attempts: 1,
						diagnostics: {
							responseId: "resp_route",
							finishReason: "stop",
							visibleTextLength: 50,
							reasoningTextLength: 8,
							rawText: "route raw text must not escape",
							prompt: "route prompt must not escape",
						},
					},
					following: { state: "pending", attempts: 0 },
					for_you: { state: "pending", attempts: 0 },
				},
			}),
			"utf8",
		);

		const response = await GET({
			request: new Request("http://localhost/api/digest-schedule"),
		});
		const body = await response.json();
		const serialized = JSON.stringify(body.runs);

		expect(body.runs.today.sources.all.diagnostics).toEqual({
			responseId: "resp_route",
			finishReason: "stop",
			visibleTextLength: 50,
			reasoningTextLength: 8,
		});
		expect(serialized).not.toContain("route raw text");
		expect(serialized).not.toContain("route prompt");
	});

	it("saves the schedule and archive dir, then reinstalls all 4 launchd agents", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/digest-schedule", {
				method: "POST",
				body: JSON.stringify({
					archiveDir: "/tmp/my-archive",
					freshnessHours: 6,
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
			today: {
				hour: 9,
				minute: 30,
				program: "birdclaw",
				birdCredentialsPath: getBirdCredentialsPath(),
			},
			"24h": {
				hour: 10,
				minute: 0,
				program: "birdclaw",
				birdCredentialsPath: getBirdCredentialsPath(),
			},
			yesterday: {
				hour: 2,
				minute: 0,
				program: "birdclaw",
				birdCredentialsPath: getBirdCredentialsPath(),
			},
			week: {
				hour: 3,
				minute: 15,
				weekday: 1,
				program: "birdclaw",
				birdCredentialsPath: getBirdCredentialsPath(),
			},
		});
		expect(reconcileAllPeriodDigestFreshnessMock).toHaveBeenCalledTimes(1);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			freshnessHours: 6,
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
			freshnessHours: 6,
			archiveDir: "/tmp/my-archive",
			schedule: { today: { hour: 9, minute: 30 } },
		});
	});

	it("reuses persisted launchd execution settings for every fixed agent", async () => {
		writeBirdclawConfig({
			digest: {
				launchd: {
					program: "/opt/homebrew/bin/birdclaw",
					envFile: "~/.config/bird/env.sh",
				},
			},
		});
		await POST({
			request: new Request("http://localhost/api/digest-schedule", {
				method: "POST",
				body: JSON.stringify({
					freshnessHours: 12,
					schedule: {
						today: { hour: 8, minute: 0 },
						"24h": { hour: 8, minute: 45 },
						yesterday: { hour: 1, minute: 0 },
						week: { hour: 2, minute: 0 },
					},
				}),
			}),
		});

		for (const period of ["today", "24h", "yesterday", "week"] as const) {
			expect(
				installAllDigestArchiveLaunchAgentsEffectMock.mock.calls[0]?.[0]?.[
					period
				],
			).toMatchObject({
				program: "/opt/homebrew/bin/birdclaw",
				envFile: "~/.config/bird/env.sh",
			});
		}
	});

	it("always forces week's weekday to Monday regardless of request body", async () => {
		await POST({
			request: new Request("http://localhost/api/digest-schedule", {
				method: "POST",
				body: JSON.stringify({
					freshnessHours: 12,
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

	it("rejects freshness outside 1-24 hours", async () => {
		await expect(
			POST({
				request: new Request("http://localhost/api/digest-schedule", {
					method: "POST",
					body: JSON.stringify({
						freshnessHours: 25,
						schedule: {
							today: { hour: 8, minute: 0 },
							"24h": { hour: 8, minute: 45 },
							yesterday: { hour: 1, minute: 0 },
							week: { hour: 2, minute: 0 },
						},
					}),
				}),
			}),
		).rejects.toThrow(/freshnessHours/u);
		expect(
			installAllDigestArchiveLaunchAgentsEffectMock,
		).not.toHaveBeenCalled();
	});

	it("surfaces fixed launchd installation failures in the top-level result", async () => {
		installAllDigestArchiveLaunchAgentsEffectMock.mockResolvedValue({
			today: { ok: false, error: "launchctl denied" },
			"24h": { ok: true, result: {} },
			yesterday: { ok: true, result: {} },
			week: { ok: true, result: {} },
		});
		const response = await POST({
			request: new Request("http://localhost/api/digest-schedule", {
				method: "POST",
				body: JSON.stringify({
					freshnessHours: 12,
					schedule: {
						today: { hour: 8, minute: 0 },
						"24h": { hour: 8, minute: 45 },
						yesterday: { hour: 1, minute: 0 },
						week: { hour: 2, minute: 0 },
					},
				}),
			}),
		});

		expect(await response.json()).toMatchObject({
			ok: false,
			installResults: { today: { ok: false, error: "launchctl denied" } },
		});
	});
});
