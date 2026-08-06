// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import {
	buildPeriodDigestFreshnessLaunchAgent,
	calculatePeriodDigestFreshnessDeadline,
	consumePeriodDigestFreshnessAttempt,
	periodDigestFreshnessStatePath,
	readPeriodDigestFreshnessState,
	reconcilePeriodDigestFreshness,
	triggerDuePeriodDigestFreshness,
	writePeriodDigestFreshnessState,
} from "./period-digest-freshness";
import { acquireScheduledJobLock } from "./scheduled-job";
import type { LaunchAgentInstallResult } from "./launchd";

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

	it("suppresses a failed source version when calculating the next deadline", () => {
		const due = calculatePeriodDigestFreshnessDeadline({
			now: new Date(2026, 7, 6, 10, 0, 0),
			freshnessSeconds: 12 * 60 * 60,
			schedule: { hour: 8, minute: 0 },
			generatedAt: {
				all: new Date(2026, 7, 6, 6, 0, 0).toISOString(),
				following: new Date(2026, 7, 6, 8, 30, 0).toISOString(),
				for_you: new Date(2026, 7, 6, 8, 30, 0).toISOString(),
			},
			suppressedSources: ["all"],
		});

		expect(due).toEqual(new Date(2026, 7, 6, 20, 30, 0));
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

	it("uses the already-rounded one-shot launchd wakeup", () => {
		const fireAt = new Date(2026, 7, 6, 10, 31, 0);
		const agent = buildPeriodDigestFreshnessLaunchAgent({
			period: "today",
			fireAt,
			attemptToken: "attempt-1",
			program: "/opt/homebrew/bin/birdclaw",
			envFile: "~/.config/bird/env.sh",
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
		expect(agent.envFile).toContain("/.config/bird/env.sh");
		expect(agent.programArguments[0]).toBe("/bin/bash");
		expect(agent.programArguments.join(" ")).toContain(
			"/opt/homebrew/bin/birdclaw",
		);
		const command = agent.programArguments.join(" ");
		for (const expected of [
			"run-period-digest",
			"--trigger",
			"freshness",
			"--origin",
			"launchd",
			"--attempt-token",
			"attempt-1",
			"--bird-credentials-path",
		]) {
			expect(command).toContain(expected);
		}
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

	it("derives a stable token and preserves its consumed state across reconciliation", async () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const install = vi.fn(
			async () => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const input = {
			period: "today" as const,
			now,
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		};
		const first = await reconcilePeriodDigestFreshness(input);
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: first.state.attemptToken,
				now,
			}),
		).resolves.toEqual({ valid: true });

		const second = await reconcilePeriodDigestFreshness(input);

		expect(second.state.attemptToken).toBe(first.state.attemptToken);
		expect(second.state.status).toBe("consumed");
		expect(install).toHaveBeenCalledTimes(1);
	});

	it("waits for the cross-process scheduler lease before installing", async () => {
		const lockPath = path.join(
			testHome().root,
			"locks",
			"period-digest-freshness-today.lock",
		);
		const release = await acquireScheduledJobLock(lockPath, 60_000);
		expect(release).toBeTypeOf("function");
		const install = vi.fn(
			async () => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const reconciliation = reconcilePeriodDigestFreshness({
			period: "today",
			now: new Date(2026, 7, 6, 10, 0, 0),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(install).not.toHaveBeenCalled();

		await release?.();
		await reconciliation;
		expect(install).toHaveBeenCalledOnce();
	});

	it("treats missing, corrupt, and incomplete freshness state as absent", async () => {
		const statePath = periodDigestFreshnessStatePath("today");
		await expect(
			readPeriodDigestFreshnessState("today"),
		).resolves.toBeUndefined();
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(statePath, "{not-json", "utf8");
		await expect(
			readPeriodDigestFreshnessState("today"),
		).resolves.toBeUndefined();

		for (const invalid of [
			{},
			{ schemaVersion: 2 },
			{ schemaVersion: 1, period: "24h" },
			{ schemaVersion: 1, period: "today", attemptToken: 1 },
			{
				schemaVersion: 1,
				period: "today",
				attemptToken: "token",
				dueAt: 1,
			},
			{
				schemaVersion: 1,
				period: "today",
				attemptToken: "token",
				dueAt: "due",
				fireAt: 1,
			},
			{
				schemaVersion: 1,
				period: "today",
				attemptToken: "token",
				dueAt: "due",
				fireAt: "fire",
				status: 1,
			},
			{
				schemaVersion: 1,
				period: "today",
				attemptToken: "token",
				dueAt: "due",
				fireAt: "fire",
				status: "scheduled",
				updatedAt: 1,
			},
		]) {
			await fs.writeFile(statePath, JSON.stringify(invalid), "utf8");
			await expect(
				readPeriodDigestFreshnessState("today"),
			).resolves.toBeUndefined();
		}
	});

	it("rejects missing, early, and cross-day freshness attempts", async () => {
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "missing",
				now: new Date(2026, 7, 6, 10, 0, 0),
			}),
		).resolves.toEqual({ valid: false, reason: "missing-state" });

		const dueAt = new Date(2026, 7, 6, 12, 0, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "current",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: new Date(2026, 7, 6, 9, 0, 0).toISOString(),
		});
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "current",
				now: new Date(2026, 7, 6, 11, 0, 0),
			}),
		).resolves.toEqual({ valid: false, reason: "not-due" });
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "current",
				now: new Date(2026, 7, 7, 12, 0, 0),
			}),
		).resolves.toEqual({ valid: false, reason: "cross-day" });
	});

	it("returns disabled without installing or triggering when due time crosses midnight", async () => {
		const install = vi.fn();
		const reconciled = await reconcilePeriodDigestFreshness({
			period: "24h",
			now: new Date(2026, 7, 6, 20, 0, 0),
			freshnessSeconds: 12 * 60 * 60,
			schedule: { hour: 18, minute: 0 },
			install,
		});
		expect(reconciled).toMatchObject({
			state: { status: "disabled", dueAt: "", fireAt: "" },
			installResult: null,
		});
		expect(install).not.toHaveBeenCalled();

		const requestRun = vi.fn();
		await expect(
			triggerDuePeriodDigestFreshness({
				period: "24h",
				origin: "cli",
				now: new Date(2026, 7, 6, 20, 1, 0),
				requestRun,
			}),
		).resolves.toEqual({ triggered: false, reason: "disabled" });
		expect(requestRun).not.toHaveBeenCalled();
	});

	it("persists non-Error launchd installation failures", async () => {
		const reconciled = await reconcilePeriodDigestFreshness({
			period: "today",
			now: new Date(2026, 7, 6, 10, 0, 0),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install: vi.fn(async () => Promise.reject("launchctl denied")),
		});
		expect(reconciled.state).toMatchObject({
			status: "error",
			installError: "launchctl denied",
		});
	});
});
