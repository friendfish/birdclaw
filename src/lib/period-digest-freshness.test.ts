// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import {
	buildPeriodDigestFreshnessLaunchAgent,
	calculatePeriodDigestFreshnessDeadline,
	consumePeriodDigestFreshnessAttempt,
	reconcilePeriodDigestFreshness,
	triggerDuePeriodDigestFreshness,
	writePeriodDigestFreshnessState,
} from "./period-digest-freshness";

const testHome = useTestHome({ prefix: "birdclaw-digest-freshness-" });

describe("period digest freshness", () => {
	it("uses each page generation time and the fixed schedule fallback", () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const due = calculatePeriodDigestFreshnessDeadline({
			now,
			freshnessSeconds: 12 * 60 * 60,
			schedule: { hour: 8, minute: 0 },
			generatedAt: {
				all: new Date(2026, 7, 6, 8, 30, 0).toISOString(),
				following: new Date(2026, 7, 6, 9, 0, 0).toISOString(),
			},
		});

		expect(due).toEqual(new Date(2026, 7, 6, 20, 0, 0));
	});

	it("recalculates from refreshed content and never schedules across a day", () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		expect(
			calculatePeriodDigestFreshnessDeadline({
				now,
				freshnessSeconds: 2 * 60 * 60,
				schedule: { hour: 8, minute: 0 },
				generatedAt: {
					all: new Date(2026, 7, 6, 10, 0, 0).toISOString(),
					following: new Date(2026, 7, 6, 10, 5, 0).toISOString(),
					for_you: new Date(2026, 7, 6, 10, 10, 0).toISOString(),
				},
			}),
		).toEqual(new Date(2026, 7, 6, 12, 0, 0));

		expect(
			calculatePeriodDigestFreshnessDeadline({
				now,
				freshnessSeconds: 12 * 60 * 60,
				schedule: { hour: 18, minute: 0 },
				generatedAt: {},
			}),
		).toBeNull();
	});

	it("rounds a one-shot launchd wakeup up to the next minute", () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 1);
		const agent = buildPeriodDigestFreshnessLaunchAgent({
			period: "today",
			dueAt,
			attemptToken: "attempt-1",
		});

		expect(agent.schedule).toEqual({
			kind: "calendar",
			year: 2026,
			month: 8,
			day: 6,
			hour: 10,
			minute: 31,
		});
		expect(agent.runAtLoad).toBe(false);
		expect(agent.programArguments).toEqual(
			expect.arrayContaining([
				"run-period-digest",
				"--trigger",
				"freshness",
				"--origin",
				"launchd",
				"--attempt-token",
				"attempt-1",
				"--bird-credentials-path",
			]),
		);
	});

	it("consumes the matching same-day attempt once and rejects stale tokens", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: "current-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: new Date(2026, 7, 6, 9, 0, 0).toISOString(),
		});

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "24h",
				attemptToken: "old-token",
				now: new Date(2026, 7, 6, 10, 31, 0),
			}),
		).resolves.toMatchObject({ valid: false, reason: "token-mismatch" });
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "24h",
				attemptToken: "current-token",
				now: new Date(2026, 7, 6, 10, 31, 0),
			}),
		).resolves.toEqual({ valid: true });
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "24h",
				attemptToken: "current-token",
				now: new Date(2026, 7, 6, 10, 32, 0),
			}),
		).resolves.toMatchObject({ valid: false, reason: "already-consumed" });

		expect(testHome().root).toBeTruthy();
	});

	it("uses the scheduled token for a page fallback and starts one freshness batch", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "page-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: new Date(2026, 7, 6, 9, 0, 0).toISOString(),
		});
		const requestRun = vi.fn(async () => ({
			runId: "fresh-run",
			joined: false,
			completion: Promise.resolve(undefined),
		}));

		await expect(
			triggerDuePeriodDigestFreshness({
				period: "today",
				origin: "page",
				now: new Date(2026, 7, 6, 10, 31, 0),
				requestRun,
			}),
		).resolves.toMatchObject({ triggered: true, runId: "fresh-run" });
		expect(requestRun).toHaveBeenCalledWith({
			period: "today",
			trigger: "freshness",
			origin: "page",
		});
		await expect(
			triggerDuePeriodDigestFreshness({
				period: "today",
				origin: "page",
				now: new Date(2026, 7, 6, 10, 32, 0),
				requestRun,
			}),
		).resolves.toMatchObject({
			triggered: false,
			reason: "already-consumed",
		});
		expect(requestRun).toHaveBeenCalledTimes(1);
	});

	it("serializes agent reconciliation and persists installation failures", async () => {
		let activeInstalls = 0;
		let maximumActiveInstalls = 0;
		const install = vi
			.fn()
			.mockImplementationOnce(async () => {
				activeInstalls += 1;
				maximumActiveInstalls = Math.max(maximumActiveInstalls, activeInstalls);
				await Promise.resolve();
				activeInstalls -= 1;
				throw new Error("launchctl denied");
			})
			.mockImplementationOnce(async () => ({ ok: true }));
		const input = {
			period: "today" as const,
			now: new Date(2026, 7, 6, 10, 0, 0),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		};

		const [first, second] = await Promise.all([
			reconcilePeriodDigestFreshness(input),
			reconcilePeriodDigestFreshness(input),
		]);

		expect(first.state).toMatchObject({
			status: "error",
			installError: "launchctl denied",
		});
		expect(second.state.status).toBe("scheduled");
		expect(maximumActiveInstalls).toBe(1);
	});
});
