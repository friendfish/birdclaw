// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import type {
	PeriodDigestContentSource,
	PeriodDigestContext,
	PeriodDigestRunResult,
} from "./period-digest";
import { publishCurrentPeriodDigest } from "./period-digest-current-store";
import {
	activatePeriodDigestFreshnessRetry,
	buildPeriodDigestFreshnessLaunchAgent,
	buildPeriodDigestFreshnessRetryReloaderLaunchAgent,
	calculatePeriodDigestFreshnessDeadline,
	completePeriodDigestFreshnessAttempt,
	consumePeriodDigestFreshnessAttempt,
	periodDigestFreshnessStatePath,
	readPeriodDigestFreshnessState,
	reconcilePeriodDigestFreshness,
	triggerDuePeriodDigestFreshness,
	type PeriodDigestFreshnessStateV1,
	writePeriodDigestFreshnessState,
} from "./period-digest-freshness";
import { periodDigestRunLockPath } from "./period-digest-orchestrator";
import { acquireScheduledJobLock } from "./scheduled-job";
import type { LaunchAgent, LaunchAgentInstallResult } from "./launchd";

const testHome = useTestHome({ prefix: "birdclaw-digest-freshness-" });

function publishCurrentSources(period: "today" | "24h", generatedAt: string) {
	const { db } = testHome();
	for (const contentSource of [
		"all",
		"following",
		"for_you",
	] as const satisfies readonly PeriodDigestContentSource[]) {
		const context: PeriodDigestContext = {
			window: {
				label: period === "today" ? "Today" : "Last 24 hours",
				since: "2026-08-20T00:00:00.000Z",
				until: "2026-08-21T08:00:00.000Z",
			},
			includeDms: false,
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
			hash: `${period}:${contentSource}`,
		};
		const result: PeriodDigestRunResult = {
			context,
			digest: {
				title: `${period} ${contentSource}`,
				summary: "A complete digest",
				keyTopics: [],
				notableLinks: [],
				people: [],
				actionItems: [],
				sourceTweetIds: [],
			},
			markdown: `# ${period} ${contentSource}`,
			model: "gpt-5.5",
			reasoningEffort: "medium",
			serviceTier: "priority",
			parseStatus: "structured",
			cached: false,
			updatedAt: generatedAt,
		};
		publishCurrentPeriodDigest(
			{
				period,
				contentSource,
				runId: "stable-run",
				versionId: `stable-${contentSource}`,
				generatedAt,
				result,
				promptHash: "prompt",
				maxTweets: 5_000,
				maxLinks: 20,
				sync: { status: "fresh", steps: [] },
			},
			db,
		);
	}
}

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

	it("clamps cross-midnight source generations to the fixed daily schedule", () => {
		const due = calculatePeriodDigestFreshnessDeadline({
			now: new Date(2026, 7, 21, 4, 2, 0),
			freshnessSeconds: 4 * 60 * 60,
			schedule: { hour: 7, minute: 30 },
			generatedAt: {
				following: new Date(2026, 7, 21, 0, 1, 0).toISOString(),
				for_you: new Date(2026, 7, 21, 0, 7, 0).toISOString(),
			},
			suppressedSources: ["all"],
		});

		expect(due).toEqual(new Date(2026, 7, 21, 11, 30, 0));
	});

	it("returns null when the clamped daily baseline crosses midnight", () => {
		const due = calculatePeriodDigestFreshnessDeadline({
			now: new Date(2026, 7, 6, 20, 0, 0),
			freshnessSeconds: 4 * 60 * 60,
			schedule: { hour: 21, minute: 0 },
			generatedAt: {
				all: new Date(2026, 7, 6, 20, 30, 0).toISOString(),
			},
		});

		expect(due).toBeNull();
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

	it("builds a separate reloader that waits for the launchd caller to exit", () => {
		const launchAgentsDir = path.join(testHome().root, "LaunchAgents");
		const agent = buildPeriodDigestFreshnessRetryReloaderLaunchAgent({
			period: "today",
			attemptToken: "retry-token",
			parentPid: 4242,
			program: "/opt/homebrew/bin/birdclaw",
			envFile: "~/.config/bird/env.sh",
			launchAgentsDir,
		});

		expect(agent.label).toBe(
			"com.steipete.birdclaw.period-digest-freshness-today-reloader",
		);
		expect(agent.runAtLoad).toBe(true);
		expect(agent.schedule).toEqual({
			kind: "interval",
			intervalSeconds: 86400,
		});
		const command = agent.programArguments.join(" ");
		for (const expected of [
			"4242",
			"deadline=$(( $(/bin/date +%s) + 21600 ))",
			'[ "$(/bin/date +%s)" -lt "$deadline" ]',
			"activate-period-digest-freshness-retry",
			"retry-token",
			launchAgentsDir,
			"launchctl remove",
		]) {
			expect(command).toContain(expected);
		}
		expect(command).not.toContain("remaining=");
		expect(command).not.toContain("run-period-digest");
	});

	it("starts the matching same-day attempt once and rejects stale tokens", async () => {
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
				origin: "launchd",
				now: new Date(2026, 7, 6, 10, 31, 0),
			}),
		).resolves.toMatchObject({ valid: false, reason: "token-mismatch" });
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "24h",
				attemptToken: "current-token",
				origin: "launchd",
				now: new Date(2026, 7, 6, 10, 31, 0),
			}),
		).resolves.toEqual({ valid: true });
		expect(await readPeriodDigestFreshnessState("24h")).toMatchObject({
			status: "running",
			runningOrigin: "launchd",
			launchdCallerPid: process.pid,
		});
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "24h",
				attemptToken: "current-token",
				origin: "launchd",
				now: new Date(2026, 7, 6, 10, 32, 0),
			}),
		).resolves.toMatchObject({ valid: false, reason: "already-running" });

		expect(testHome().root).toBeTruthy();
	});

	it("ignores stale retryAt on a scheduled attempt", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 0, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "scheduled-with-stale-retry",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			retryAt: new Date(2026, 7, 7, 0, 15, 0).toISOString(),
			updatedAt: dueAt.toISOString(),
		});

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "scheduled-with-stale-retry",
				origin: "page",
				now: new Date(2026, 7, 6, 23, 50, 0),
			}),
		).resolves.toEqual({ valid: true });
	});

	it("reclaims an orphaned running attempt after its lease expires", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		const startedAt = new Date(2026, 7, 6, 10, 31, 0);
		const eligibleAt = new Date(2026, 7, 6, 10, 46, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "orphaned-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "running",
			startedAt: startedAt.toISOString(),
			runningOrigin: "launchd",
			launchdCallerPid: 4242,
			updatedAt: startedAt.toISOString(),
		});

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "orphaned-token",
				origin: "page",
				now: new Date(2026, 7, 6, 10, 40, 0),
			}),
		).resolves.toEqual({
			valid: false,
			reason: "already-running",
			eligibleAt: eligibleAt.toISOString(),
		});

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "orphaned-token",
				origin: "page",
				now: eligibleAt,
			}),
		).resolves.toEqual({ valid: true });
		expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
			status: "running",
			startedAt: eligibleAt.toISOString(),
			runningOrigin: "page",
			launchdCallerPid: 4242,
		});
	});

	it("moves a failed running attempt through bounded retry backoff", async () => {
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "retry-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: dueAt.toISOString(),
		});

		const failureTimes = [
			new Date(2026, 7, 6, 10, 31, 0),
			new Date(2026, 7, 6, 10, 47, 0),
			new Date(2026, 7, 6, 11, 48, 0),
			new Date(2026, 7, 6, 15, 49, 0),
		];
		const expectedRetryAt = [
			new Date(2026, 7, 6, 10, 46, 0),
			new Date(2026, 7, 6, 11, 47, 0),
			new Date(2026, 7, 6, 15, 48, 0),
		];
		const completedStates = [];

		for (const now of failureTimes) {
			await expect(
				consumePeriodDigestFreshnessAttempt({
					period: "today",
					attemptToken: "retry-token",
					origin: "launchd",
					now,
				}),
			).resolves.toEqual({ valid: true });
			expect((await readPeriodDigestFreshnessState("today"))?.status).toBe(
				"running",
			);

			const completed = await completePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "retry-token",
				origin: "launchd",
				outcome: "failed",
				now,
				install,
			});
			if (!completed.state) {
				throw new Error("Expected the freshness attempt to have state");
			}
			completedStates.push({
				status: completed.state.status,
				retryCount: completed.state.retryCount,
				retryAt: completed.state.retryAt,
			});
		}
		expect(completedStates).toEqual([
			...expectedRetryAt.map((retryAt, index) => ({
				status: "retryable",
				retryCount: index + 1,
				retryAt: retryAt.toISOString(),
			})),
			{
				status: "failed",
				retryCount: 3,
				retryAt: expectedRetryAt.at(-1)?.toISOString(),
			},
		]);
		expect(install).toHaveBeenCalledTimes(3);
		for (const [agent] of install.mock.calls) {
			expect(agent.label).toBe(
				"com.steipete.birdclaw.period-digest-freshness-today-reloader",
			);
		}
	});

	it("defers a page-owned failure retry while its launchd caller exits", async () => {
		const now = new Date(2026, 7, 6, 10, 31, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "joined-failure-token",
			dueAt: new Date(2026, 7, 6, 10, 30, 0).toISOString(),
			fireAt: new Date(2026, 7, 6, 10, 30, 0).toISOString(),
			status: "running",
			startedAt: now.toISOString(),
			runningOrigin: "page",
			launchdCallerPid: 4242,
			updatedAt: now.toISOString(),
		});
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);

		const completed = await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "joined-failure-token",
			origin: "page",
			outcome: "failed",
			now,
			install,
		});

		expect(completed.state).toMatchObject({ status: "retryable" });
		expect(install).toHaveBeenCalledOnce();
		expect(install.mock.calls[0]?.[0]).toMatchObject({
			label: "com.steipete.birdclaw.period-digest-freshness-today-reloader",
			runAtLoad: true,
		});
		expect(install.mock.calls[0]?.[0].programArguments.join(" ")).toContain(
			"kill -0 4242",
		);
	});

	it("activates a deferred retry only while the token remains retryable", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		const retryAt = new Date(2026, 7, 6, 10, 46, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "deferred-token",
			dueAt: dueAt.toISOString(),
			fireAt: retryAt.toISOString(),
			status: "retryable",
			retryCount: 1,
			retryAt: retryAt.toISOString(),
			updatedAt: dueAt.toISOString(),
		});
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);

		const activated = await activatePeriodDigestFreshnessRetry({
			period: "today",
			attemptToken: "deferred-token",
			now: new Date(2026, 7, 6, 10, 32, 0),
			install,
			program: "/opt/homebrew/bin/birdclaw",
		});

		expect(activated.activated).toBe(true);
		expect(install).toHaveBeenCalledOnce();
		expect(install.mock.calls[0]?.[0]).toMatchObject({
			label: "com.steipete.birdclaw.period-digest-freshness-today",
			schedule: {
				kind: "calendar",
				year: 2026,
				month: 8,
				day: 6,
				hour: 10,
				minute: 46,
			},
		});
		expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
			status: "retryable",
			attemptToken: "deferred-token",
		});

		await writePeriodDigestFreshnessState({
			...(await readPeriodDigestFreshnessState("today"))!,
			status: "failed",
		});
		await expect(
			activatePeriodDigestFreshnessRetry({
				period: "today",
				attemptToken: "deferred-token",
				install,
			}),
		).resolves.toMatchObject({
			activated: false,
			reason: "not-activatable",
		});
		expect(install).toHaveBeenCalledOnce();
	});

	it("moves an expired deferred activation to the next minute", async () => {
		const dueAt = new Date(2026, 7, 6, 12, 0, 0);
		const retryAt = new Date(2026, 7, 6, 13, 0, 0);
		const now = new Date(2026, 7, 6, 18, 0, 0);
		const expectedFireAt = new Date(2026, 7, 6, 18, 1, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "late-activation-token",
			dueAt: dueAt.toISOString(),
			fireAt: retryAt.toISOString(),
			status: "retryable",
			retryCount: 1,
			retryAt: retryAt.toISOString(),
			updatedAt: retryAt.toISOString(),
		});
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);

		const activated = await activatePeriodDigestFreshnessRetry({
			period: "today",
			attemptToken: "late-activation-token",
			now,
			install,
		});

		expect(activated.activated).toBe(true);
		expect(install).toHaveBeenCalledOnce();
		expect(install.mock.calls[0]?.[0].schedule).toMatchObject({
			kind: "calendar",
			year: 2026,
			month: 8,
			day: 6,
			hour: 18,
			minute: 1,
		});
		expect(activated.state).toMatchObject({
			status: "retryable",
			fireAt: expectedFireAt.toISOString(),
			retryAt: retryAt.toISOString(),
		});
		expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
			fireAt: expectedFireAt.toISOString(),
		});
	});

	it("stabilizes deferred activation with a full-minute margin", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 0, 0);
		const desiredFireAt = new Date(2026, 7, 6, 10, 31, 0);
		const initialNow = new Date(2026, 7, 6, 10, 30, 59, 900);
		const installNow = new Date(2026, 7, 6, 10, 31, 0, 100);
		const secondInstallNow = new Date(2026, 7, 6, 10, 32, 0, 100);
		const expectedFireAt = new Date(2026, 7, 6, 10, 34, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "lease-delayed-activation-token",
			dueAt: dueAt.toISOString(),
			fireAt: desiredFireAt.toISOString(),
			status: "scheduled",
			updatedAt: initialNow.toISOString(),
		});
		const clock = vi
			.fn<() => Date>()
			.mockReturnValueOnce(initialNow)
			.mockReturnValueOnce(installNow)
			.mockReturnValue(secondInstallNow);
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);

		const activated = await activatePeriodDigestFreshnessRetry({
			period: "today",
			attemptToken: "lease-delayed-activation-token",
			now: initialNow,
			clock,
			install,
		});

		expect(activated).toMatchObject({
			activated: true,
			state: { fireAt: expectedFireAt.toISOString() },
		});
		expect(install.mock.calls[0]?.[0].schedule).toMatchObject({
			kind: "calendar",
			year: 2026,
			month: 8,
			day: 6,
			hour: 10,
			minute: 34,
		});
		expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
			fireAt: expectedFireAt.toISOString(),
		});
	});

	it("disables a deferred activation when the next minute crosses days", async () => {
		const dueAt = new Date(2026, 7, 6, 22, 0, 0);
		const retryAt = new Date(2026, 7, 6, 23, 0, 0);
		const now = new Date(2026, 7, 6, 23, 59, 59);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: "cross-day-activation-token",
			dueAt: dueAt.toISOString(),
			fireAt: retryAt.toISOString(),
			status: "retryable",
			retryCount: 1,
			retryAt: retryAt.toISOString(),
			updatedAt: retryAt.toISOString(),
		});
		const install = vi.fn();

		const activated = await activatePeriodDigestFreshnessRetry({
			period: "24h",
			attemptToken: "cross-day-activation-token",
			now,
			install,
		});

		expect(activated).toMatchObject({
			activated: false,
			reason: "cross-day",
			state: { status: "disabled", fireAt: "" },
		});
		expect(install).not.toHaveBeenCalled();
	});

	it("activates a deferred next-generation schedule after its caller exits", async () => {
		const dueAt = new Date(2026, 7, 6, 12, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "next-generation-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: new Date(2026, 7, 6, 10, 32, 0).toISOString(),
		});
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);

		const activated = await activatePeriodDigestFreshnessRetry({
			period: "today",
			attemptToken: "next-generation-token",
			now: new Date(2026, 7, 6, 10, 33, 0),
			install,
		});

		expect(activated.activated).toBe(true);
		expect(install).toHaveBeenCalledOnce();
		expect(install.mock.calls[0]?.[0]).toMatchObject({
			label: "com.steipete.birdclaw.period-digest-freshness-today",
			schedule: {
				kind: "calendar",
				year: 2026,
				month: 8,
				day: 6,
				hour: 12,
				minute: 30,
			},
		});
	});

	it("persists deferred retry activation failures", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		const retryAt = new Date(2026, 7, 6, 10, 46, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: "deferred-error-token",
			dueAt: dueAt.toISOString(),
			fireAt: retryAt.toISOString(),
			status: "retryable",
			retryCount: 1,
			retryAt: retryAt.toISOString(),
			updatedAt: dueAt.toISOString(),
		});

		const activated = await activatePeriodDigestFreshnessRetry({
			period: "24h",
			attemptToken: "deferred-error-token",
			now: new Date(2026, 7, 6, 10, 32, 0),
			install: vi.fn(async () => Promise.reject(new Error("launchctl denied"))),
		});

		expect(activated.activated).toBe(false);
		expect(activated.state).toMatchObject({
			status: "error",
			installError: "launchctl denied",
		});
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
			completion: Promise.resolve({ phase: "completed" as const }),
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

	it.each([
		{
			label: "cross-day dueAt",
			dueAt: new Date(2026, 7, 20, 11, 30, 0).toISOString(),
		},
		{ label: "disabled state", dueAt: "" },
	])(
		"rebuilds an earlier $label before checking eligibility",
		async ({ dueAt }) => {
			await writePeriodDigestFreshnessState({
				schemaVersion: 1,
				period: "24h",
				attemptToken: "old-cycle-token",
				dueAt,
				fireAt: "",
				status: dueAt ? "scheduled" : "disabled",
				updatedAt: new Date(2026, 7, 20, 23, 0, 0).toISOString(),
			});
			const install = vi.fn(
				async () => ({ ok: true }) as LaunchAgentInstallResult,
			);
			const reconcile = vi.fn(
				(input: Parameters<typeof reconcilePeriodDigestFreshness>[0]) =>
					reconcilePeriodDigestFreshness({
						...input,
						freshnessSeconds: 4 * 60 * 60,
						schedule: { hour: 7, minute: 30 },
						install,
					}),
			);
			const requestRun = vi.fn();
			const input = {
				period: "24h" as const,
				origin: "page" as const,
				now: new Date(2026, 7, 21, 8, 0, 0),
				requestRun,
				reconcile,
			};

			await expect(triggerDuePeriodDigestFreshness(input)).resolves.toEqual({
				triggered: false,
				reason: "not-due",
				eligibleAt: new Date(2026, 7, 21, 11, 30, 0).toISOString(),
			});
			expect(reconcile).toHaveBeenCalledOnce();
			expect(install).toHaveBeenCalledOnce();
			expect(requestRun).not.toHaveBeenCalled();
			await expect(
				consumePeriodDigestFreshnessAttempt({
					period: "24h",
					attemptToken: "old-cycle-token",
					origin: "launchd",
					now: new Date(2026, 7, 21, 8, 1, 0),
				}),
			).resolves.toMatchObject({ valid: false, reason: "token-mismatch" });
		},
	);

	it("rebuilds freshness state when both cycle timestamps are invalid", async () => {
		publishCurrentSources("24h", new Date(2026, 7, 20, 9, 0, 0).toISOString());
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: "invalid-cycle-token",
			dueAt: "invalid",
			fireAt: "",
			status: "scheduled",
			updatedAt: "also-invalid",
		});
		const install = vi.fn(
			async () => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const reconcile = vi.fn(
			(input: Parameters<typeof reconcilePeriodDigestFreshness>[0]) =>
				reconcilePeriodDigestFreshness({
					...input,
					freshnessSeconds: 4 * 60 * 60,
					schedule: { hour: 7, minute: 30 },
					install,
				}),
		);
		const requestRun = vi.fn();

		await expect(
			triggerDuePeriodDigestFreshness({
				period: "24h",
				origin: "page",
				now: new Date(2026, 7, 21, 8, 0, 0),
				requestRun,
				reconcile,
			}),
		).resolves.toEqual({
			triggered: false,
			reason: "not-due",
			eligibleAt: new Date(2026, 7, 21, 11, 30, 0).toISOString(),
		});
		expect(reconcile).toHaveBeenCalledOnce();
		expect(install).toHaveBeenCalledOnce();
		expect(requestRun).not.toHaveBeenCalled();
	});

	it("contains stale-state reconciliation failures at the trigger boundary", async () => {
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "stale-error-token",
			dueAt: new Date(2026, 7, 20, 11, 0, 0).toISOString(),
			fireAt: "",
			status: "scheduled",
			updatedAt: new Date(2026, 7, 20, 10, 0, 0).toISOString(),
		});
		const reconcile = vi.fn(async () =>
			Promise.reject(new Error("scheduler locked")),
		);
		const requestRun = vi.fn();

		await expect(
			triggerDuePeriodDigestFreshness({
				period: "today",
				origin: "page",
				now: new Date(2026, 7, 21, 8, 0, 0),
				requestRun,
				reconcile,
			}),
		).resolves.toEqual({
			triggered: false,
			reason: "reconcile-error",
		});
		expect(reconcile).toHaveBeenCalledOnce();
		expect(requestRun).not.toHaveBeenCalled();
	});

	it("does not loop when an active cross-day run prevents rebuilding", async () => {
		const previous: PeriodDigestFreshnessStateV1 = {
			schemaVersion: 1,
			period: "today",
			attemptToken: "running-old-cycle",
			dueAt: new Date(2026, 7, 20, 23, 30, 0).toISOString(),
			fireAt: new Date(2026, 7, 20, 23, 30, 0).toISOString(),
			status: "running",
			startedAt: new Date(2026, 7, 21, 0, 1, 0).toISOString(),
			updatedAt: new Date(2026, 7, 21, 0, 1, 0).toISOString(),
		};
		await writePeriodDigestFreshnessState(previous);
		const install = vi.fn(
			async () => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const reconcile = vi.fn(
			(input: Parameters<typeof reconcilePeriodDigestFreshness>[0]) =>
				reconcilePeriodDigestFreshness({
					...input,
					freshnessSeconds: 4 * 60 * 60,
					schedule: { hour: 7, minute: 0 },
					install,
				}),
		);
		const requestRun = vi.fn();
		const input = {
			period: "today" as const,
			origin: "page" as const,
			now: new Date(2026, 7, 21, 0, 5, 0),
			requestRun,
			reconcile,
		};

		await expect(triggerDuePeriodDigestFreshness(input)).resolves.toEqual({
			triggered: false,
			reason: "cross-day",
		});
		expect(reconcile).toHaveBeenCalledOnce();
		expect(install).not.toHaveBeenCalled();
		expect(requestRun).not.toHaveBeenCalled();
	});

	it("starts one overdue daily baseline after rebuilding stale disabled state", async () => {
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: "disabled-old-cycle",
			dueAt: "",
			fireAt: "",
			status: "disabled",
			updatedAt: new Date(2026, 7, 20, 23, 0, 0).toISOString(),
		});
		const install = vi.fn(
			async () => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const reconcile = vi.fn(
			(input: Parameters<typeof reconcilePeriodDigestFreshness>[0]) =>
				reconcilePeriodDigestFreshness({
					...input,
					freshnessSeconds: 4 * 60 * 60,
					schedule: { hour: 7, minute: 30 },
					install,
				}),
		);
		const requestRun = vi.fn(async () => ({
			runId: "overdue-run",
			joined: false,
			completion: new Promise<{ phase: "completed" }>(() => undefined),
		}));
		const input = {
			period: "24h" as const,
			origin: "page" as const,
			now: new Date(2026, 7, 21, 12, 0, 0),
			requestRun,
			reconcile,
		};

		await expect(triggerDuePeriodDigestFreshness(input)).resolves.toMatchObject(
			{
				triggered: true,
				runId: "overdue-run",
			},
		);
		await expect(triggerDuePeriodDigestFreshness(input)).resolves.toMatchObject(
			{
				triggered: false,
				reason: "already-running",
			},
		);
		expect(reconcile).toHaveBeenCalledOnce();
		expect(install).toHaveBeenCalledOnce();
		expect(requestRun).toHaveBeenCalledOnce();
	});

	it.each([
		{ label: "current", updatedAt: new Date(2026, 7, 21, 8, 0, 0) },
		{ label: "future", updatedAt: new Date(2026, 7, 22, 8, 0, 0) },
	])("does not rebuild a $label-day disabled state", async ({ updatedAt }) => {
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: `${updatedAt.toISOString()}-disabled`,
			dueAt: "",
			fireAt: "",
			status: "disabled",
			updatedAt: updatedAt.toISOString(),
		});
		const reconcile = vi.fn();
		const input = {
			period: "today" as const,
			origin: "page" as const,
			now: new Date(2026, 7, 21, 9, 0, 0),
			reconcile,
		};

		await expect(triggerDuePeriodDigestFreshness(input)).resolves.toEqual({
			triggered: false,
			reason: "disabled",
		});
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("reports a page-triggered all-source failure to the state machine", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "failed-page-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: dueAt.toISOString(),
		});
		const requestRun = vi.fn(async () => ({
			runId: "failed-run",
			joined: false,
			completion: Promise.resolve({ phase: "failed" as const }),
		}));
		const completeAttempt = vi.fn(async () => ({
			state: undefined,
			installResult: null,
			updated: false as const,
		}));

		await triggerDuePeriodDigestFreshness({
			period: "today",
			origin: "page",
			now: new Date(2026, 7, 6, 10, 31, 0),
			requestRun,
			completeAttempt,
		});
		await vi.waitFor(() => {
			expect(completeAttempt).toHaveBeenCalledWith({
				period: "today",
				attemptToken: "failed-page-token",
				origin: "page",
				outcome: "failed",
			});
		});
	});

	it("reports a page-triggered run startup error to the state machine", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "startup-error-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: dueAt.toISOString(),
		});
		const requestRun = vi.fn(async () => {
			throw new Error("run startup failed");
		});
		const completeAttempt = vi.fn(async () => ({
			state: undefined,
			installResult: null,
			updated: false as const,
		}));

		await expect(
			triggerDuePeriodDigestFreshness({
				period: "today",
				origin: "page",
				now: new Date(2026, 7, 6, 10, 31, 0),
				requestRun,
				completeAttempt,
			}),
		).rejects.toThrow("run startup failed");
		expect(completeAttempt).toHaveBeenCalledWith({
			period: "today",
			attemptToken: "startup-error-token",
			origin: "page",
			outcome: "failed",
		});
	});

	it("reports a rejected page-triggered completion to the state machine", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "rejected-completion-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: dueAt.toISOString(),
		});
		let rejectCompletion!: (error: Error) => void;
		const completion = new Promise<{
			phase: "completed" | "degraded" | "failed";
		}>((_, reject) => {
			rejectCompletion = reject;
		});
		const requestRun = vi.fn(async () => ({
			runId: "rejected-run",
			joined: false,
			completion,
		}));
		const completeAttempt = vi.fn(async () => ({
			state: undefined,
			installResult: null,
			updated: false as const,
		}));

		await triggerDuePeriodDigestFreshness({
			period: "today",
			origin: "page",
			now: new Date(2026, 7, 6, 10, 31, 0),
			requestRun,
			completeAttempt,
		});
		rejectCompletion(new Error("completion failed"));
		await vi.waitFor(() => {
			expect(completeAttempt).toHaveBeenCalledWith({
				period: "today",
				attemptToken: "rejected-completion-token",
				origin: "page",
				outcome: "failed",
			});
		});
	});

	it("recovers a failed launchd attempt from the page on the same day", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "dark-wake-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: dueAt.toISOString(),
		});
		await consumePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "dark-wake-token",
			origin: "launchd",
			now: new Date(2026, 7, 6, 10, 31, 0),
		});
		const install = vi.fn(
			async () => ({ ok: true }) as LaunchAgentInstallResult,
		);
		await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "dark-wake-token",
			origin: "launchd",
			outcome: "failed",
			now: new Date(2026, 7, 6, 10, 31, 0),
			install,
		});
		const successAt = new Date(2026, 7, 6, 10, 46, 0);
		const requestRun = vi.fn(async () => ({
			runId: "recovery-run",
			joined: false,
			completion: Promise.resolve({ phase: "completed" as const }),
		}));

		await triggerDuePeriodDigestFreshness({
			period: "today",
			origin: "page",
			now: successAt,
			requestRun,
			completeAttempt: (input) =>
				completePeriodDigestFreshnessAttempt({
					...input,
					now: successAt,
					install,
				}),
		});
		await vi.waitFor(async () => {
			expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
				status: "consumed",
				retryCount: 1,
			});
		});
		expect(requestRun).toHaveBeenCalledOnce();
		expect(install).toHaveBeenCalledOnce();
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

	it("starts a new daily attempt when source versions are unchanged", async () => {
		publishCurrentSources(
			"today",
			new Date(2026, 7, 20, 9, 0, 0).toISOString(),
		);
		const install = vi.fn(
			async () => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const first = await reconcilePeriodDigestFreshness({
			period: "today",
			now: new Date(2026, 7, 20, 10, 0, 0),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		});
		await writePeriodDigestFreshnessState({
			...first.state,
			status: "consumed",
			consumedAt: new Date(2026, 7, 20, 10, 1, 0).toISOString(),
			completedAt: new Date(2026, 7, 20, 10, 1, 0).toISOString(),
		});
		install.mockClear();

		const second = await reconcilePeriodDigestFreshness({
			period: "today",
			now: new Date(2026, 7, 21, 8, 30, 0),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		});

		expect(second.state).toMatchObject({
			status: "scheduled",
			dueAt: new Date(2026, 7, 21, 9, 0, 0).toISOString(),
		});
		expect(second.state.attemptToken).not.toBe(first.state.attemptToken);
		expect(install).toHaveBeenCalledOnce();
	});

	it("does not inherit source suppressions from an earlier local day", async () => {
		publishCurrentSources("24h", new Date(2026, 7, 20, 9, 0, 0).toISOString());
		const sourceIdentities = {
			all: "stable-all",
			following: "stable-following",
			for_you: "stable-for_you",
		};
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: "previous-cycle",
			dueAt: new Date(2026, 7, 20, 12, 0, 0).toISOString(),
			fireAt: "",
			status: "disabled",
			updatedAt: new Date(2026, 7, 20, 23, 0, 0).toISOString(),
			freshnessSeconds: 60 * 60,
			sourceIdentities,
			suppressedSourceIdentities: sourceIdentities,
		});
		const install = vi.fn(
			async () => ({ ok: true }) as LaunchAgentInstallResult,
		);

		const reconciled = await reconcilePeriodDigestFreshness({
			period: "24h",
			now: new Date(2026, 7, 21, 8, 30, 0),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		});

		expect(reconciled.state).toMatchObject({
			status: "scheduled",
			dueAt: new Date(2026, 7, 21, 9, 0, 0).toISOString(),
		});
		expect(reconciled.state.suppressedSourceIdentities).toEqual({});
		expect(install).toHaveBeenCalledOnce();
	});

	it("retains source suppressions within the same local day", async () => {
		publishCurrentSources(
			"today",
			new Date(2026, 7, 20, 9, 0, 0).toISOString(),
		);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "same-cycle",
			dueAt: new Date(2026, 7, 20, 10, 0, 0).toISOString(),
			fireAt: new Date(2026, 7, 20, 10, 0, 0).toISOString(),
			status: "scheduled",
			updatedAt: new Date(2026, 7, 20, 9, 30, 0).toISOString(),
			freshnessSeconds: 60 * 60,
			sourceIdentities: {
				all: "stable-all",
				following: "stable-following",
				for_you: "stable-for_you",
			},
			suppressedSourceIdentities: { all: "stable-all" },
		});

		const reconciled = await reconcilePeriodDigestFreshness({
			period: "today",
			now: new Date(2026, 7, 20, 10, 0, 0),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install: vi.fn(async () => ({ ok: true }) as LaunchAgentInstallResult),
		});

		expect(reconciled.state.suppressedSourceIdentities).toEqual({
			all: "stable-all",
		});
	});

	it("disables reconciliation when the next-minute fire time crosses days", async () => {
		const install = vi.fn();

		const reconciled = await reconcilePeriodDigestFreshness({
			period: "24h",
			now: new Date(2026, 7, 6, 23, 59, 59),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		});

		expect(reconciled.state).toMatchObject({
			status: "disabled",
			fireAt: "",
		});
		expect(install).not.toHaveBeenCalled();
	});

	it("disables reconciliation when installation is delayed across days", async () => {
		const initialNow = new Date(2026, 7, 6, 23, 58, 59, 900);
		const installNow = new Date(2026, 7, 6, 23, 59, 0, 100);
		const clock = vi
			.fn<() => Date>()
			.mockReturnValueOnce(initialNow)
			.mockReturnValue(installNow);
		const install = vi.fn();

		const reconciled = await reconcilePeriodDigestFreshness({
			period: "24h",
			now: initialNow,
			clock,
			freshnessSeconds: 60,
			schedule: { hour: 23, minute: 58 },
			install,
		});

		expect(reconciled.state).toMatchObject({
			status: "disabled",
			fireAt: "",
		});
		expect(install).not.toHaveBeenCalled();
	});

	it("installs a reloader instead of replacing a running launchd freshness agent", async () => {
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);

		const reconciled = await reconcilePeriodDigestFreshness({
			period: "today",
			now: new Date(2026, 7, 6, 10, 0, 0),
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			deferLaunchAgentReload: true,
			install,
			program: "/opt/homebrew/bin/birdclaw",
		});

		expect(reconciled.state.status).toBe("scheduled");
		expect(install).toHaveBeenCalledOnce();
		expect(install.mock.calls[0]?.[0]).toMatchObject({
			label: "com.steipete.birdclaw.period-digest-freshness-today-reloader",
			runAtLoad: true,
		});
		expect(install.mock.calls[0]?.[0].programArguments.join(" ")).toContain(
			reconciled.state.attemptToken,
		);
		expect(install.mock.calls[0]?.[0].programArguments.join(" ")).toContain(
			`kill -0 ${String(process.pid)}`,
		);
	});

	it("does not defer a legacy launchd state without caller pid", async () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const initial = await reconcilePeriodDigestFreshness({
			period: "today",
			now,
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		});
		install.mockClear();
		await writePeriodDigestFreshnessState({
			...initial.state,
			status: "running",
			runningOrigin: "launchd",
			startedAt: now.toISOString(),
			updatedAt: now.toISOString(),
		});

		const reconciled = await reconcilePeriodDigestFreshness({
			period: "today",
			now,
			freshnessSeconds: 2 * 60 * 60,
			schedule: { hour: 8, minute: 0 },
			replaceRunningAttempt: true,
			install,
		});

		expect(reconciled.state.status).toBe("scheduled");
		expect(install).toHaveBeenCalledOnce();
		expect(install.mock.calls[0]?.[0]).toMatchObject({
			label: "com.steipete.birdclaw.period-digest-freshness-today",
			runAtLoad: false,
		});
	});

	it("preserves a running attempt when a configuration change creates a new token", async () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const initial = await reconcilePeriodDigestFreshness({
			period: "today",
			now,
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		});
		install.mockClear();
		await writePeriodDigestFreshnessState({
			...initial.state,
			status: "running",
			runningOrigin: "launchd",
			startedAt: new Date(now.getTime() - 16 * 60_000).toISOString(),
			updatedAt: new Date(now.getTime() - 16 * 60_000).toISOString(),
		});
		const release = await acquireScheduledJobLock(
			periodDigestRunLockPath("today"),
			60_000,
		);
		if (!release) throw new Error("Expected the digest lock to be acquired");

		try {
			const reconciled = await reconcilePeriodDigestFreshness({
				period: "today",
				now,
				freshnessSeconds: 2 * 60 * 60,
				schedule: { hour: 9, minute: 0 },
				install,
			});

			expect(reconciled.state).toMatchObject({
				attemptToken: initial.state.attemptToken,
				status: "running",
				runningOrigin: "launchd",
			});
			expect(install).not.toHaveBeenCalled();
		} finally {
			await release();
		}
	});

	it("publishes a new attempt through a reloader for a launchd-owned run", async () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const initial = await reconcilePeriodDigestFreshness({
			period: "24h",
			now,
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		});
		install.mockClear();
		await writePeriodDigestFreshnessState({
			...initial.state,
			status: "running",
			runningOrigin: "page",
			launchdCallerPid: 4242,
			startedAt: now.toISOString(),
			updatedAt: now.toISOString(),
		});

		const reconciled = await reconcilePeriodDigestFreshness({
			period: "24h",
			now,
			freshnessSeconds: 2 * 60 * 60,
			schedule: { hour: 8, minute: 0 },
			replaceRunningAttempt: true,
			install,
			program: "/opt/homebrew/bin/birdclaw",
		});

		expect(reconciled.state).toMatchObject({ status: "scheduled" });
		expect(reconciled.state.attemptToken).not.toBe(initial.state.attemptToken);
		expect(install).toHaveBeenCalledOnce();
		expect(install.mock.calls[0]?.[0]).toMatchObject({
			label: "com.steipete.birdclaw.period-digest-freshness-24h-reloader",
			runAtLoad: true,
		});
		expect(install.mock.calls[0]?.[0].programArguments.join(" ")).toContain(
			"kill -0 4242",
		);
	});

	it("reschedules an expired running attempt after its digest lock is gone", async () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const input = {
			period: "today" as const,
			now,
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		};
		const initial = await reconcilePeriodDigestFreshness(input);
		install.mockClear();
		await writePeriodDigestFreshnessState({
			...initial.state,
			status: "running",
			startedAt: new Date(now.getTime() - 16 * 60_000).toISOString(),
			updatedAt: new Date(now.getTime() - 16 * 60_000).toISOString(),
		});

		const reconciled = await reconcilePeriodDigestFreshness(input);

		expect(reconciled.state.status).toBe("scheduled");
		expect(install).toHaveBeenCalledOnce();
	});

	it("preserves an expired running attempt while its digest lock is active", async () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const install = vi.fn(
			async (_agent: LaunchAgent) => ({ ok: true }) as LaunchAgentInstallResult,
		);
		const input = {
			period: "24h" as const,
			now,
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install,
		};
		const initial = await reconcilePeriodDigestFreshness(input);
		install.mockClear();
		await writePeriodDigestFreshnessState({
			...initial.state,
			status: "running",
			startedAt: new Date(now.getTime() - 16 * 60_000).toISOString(),
			updatedAt: new Date(now.getTime() - 16 * 60_000).toISOString(),
		});
		const release = await acquireScheduledJobLock(
			periodDigestRunLockPath("24h"),
			60_000,
		);
		if (!release) throw new Error("Expected the digest lock to be acquired");

		try {
			const reconciled = await reconcilePeriodDigestFreshness(input);
			expect(reconciled.state.status).toBe("running");
			expect(install).not.toHaveBeenCalled();
		} finally {
			await release();
		}
	});

	it("preserves retry eligibility when reconciling an install error", async () => {
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const retryAt = new Date(2026, 7, 6, 11, 0, 0);
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
		const initial = await reconcilePeriodDigestFreshness(input);
		await writePeriodDigestFreshnessState({
			...initial.state,
			status: "error",
			retryCount: 1,
			retryAt: retryAt.toISOString(),
			fireAt: retryAt.toISOString(),
			installError: "launchctl denied",
		});

		const reconciled = await reconcilePeriodDigestFreshness(input);

		expect(reconciled.state).toMatchObject({
			status: "retryable",
			retryCount: 1,
			retryAt: retryAt.toISOString(),
		});
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: initial.state.attemptToken,
				origin: "page",
				now: new Date(2026, 7, 6, 10, 5, 0),
			}),
		).resolves.toEqual({
			valid: false,
			reason: "not-due",
			eligibleAt: retryAt.toISOString(),
		});
	});

	it("clears stale retryAt when reconciling a scheduled attempt", async () => {
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
		const initial = await reconcilePeriodDigestFreshness(input);
		await writePeriodDigestFreshnessState({
			...initial.state,
			status: "disabled",
			fireAt: "",
			retryCount: 1,
			retryAt: new Date(2026, 7, 7, 0, 15, 0).toISOString(),
		});
		install.mockClear();

		const reconciled = await reconcilePeriodDigestFreshness(input);

		expect(reconciled.state).toMatchObject({
			status: "scheduled",
			retryCount: 1,
		});
		expect(reconciled.state).not.toHaveProperty("retryAt");
		expect(install).toHaveBeenCalledOnce();
	});

	it("derives a stable token and preserves its lifecycle across reconciliation", async () => {
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
				origin: "launchd",
				now,
			}),
		).resolves.toEqual({ valid: true });

		const second = await reconcilePeriodDigestFreshness(input);

		expect(second.state.attemptToken).toBe(first.state.attemptToken);
		expect(second.state.status).toBe("running");
		await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: first.state.attemptToken,
			origin: "cli",
			outcome: "published",
			now,
		});
		const third = await reconcilePeriodDigestFreshness(input);
		expect(third.state.status).toBe("consumed");
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

	it("allows one same-day page recovery after automatic retries are exhausted", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "page-recovery",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "failed",
			retryCount: 3,
			updatedAt: new Date(2026, 7, 6, 15, 0, 0).toISOString(),
		});
		const now = new Date(2026, 7, 6, 16, 0, 0);

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "page-recovery",
				origin: "page",
				now,
			}),
		).resolves.toEqual({ valid: true });
		expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
			status: "running",
			pageRecoveryUsedAt: now.toISOString(),
		});

		const install = vi.fn();
		await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "page-recovery",
			origin: "page",
			outcome: "failed",
			now: new Date(2026, 7, 6, 16, 1, 0),
			install,
		});
		expect(await readPeriodDigestFreshnessState("today")).toMatchObject({
			status: "failed",
			retryCount: 3,
		});
		expect(install).not.toHaveBeenCalled();
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "page-recovery",
				origin: "page",
				now: new Date(2026, 7, 6, 16, 2, 0),
			}),
		).resolves.toEqual({ valid: false, reason: "already-consumed" });
	});

	it.each(["consumed", "error"] as const)(
		"recovers one legacy %s state from the page",
		async (status) => {
			const dueAt = new Date(2026, 7, 6, 10, 30, 0);
			await writePeriodDigestFreshnessState({
				schemaVersion: 1,
				period: "24h",
				attemptToken: `legacy-${status}`,
				dueAt: dueAt.toISOString(),
				fireAt: dueAt.toISOString(),
				status,
				updatedAt: dueAt.toISOString(),
			});

			await expect(
				consumePeriodDigestFreshnessAttempt({
					period: "24h",
					attemptToken: `legacy-${status}`,
					origin: "page",
					now: new Date(2026, 7, 6, 12, 0, 0),
				}),
			).resolves.toEqual({ valid: true });
			expect(await readPeriodDigestFreshnessState("24h")).toMatchObject({
				status: "running",
				pageRecoveryUsedAt: new Date(2026, 7, 6, 12, 0, 0).toISOString(),
			});
		},
	);

	it("does not recover a legacy consumed attempt before its due time", async () => {
		const dueAt = new Date(2026, 7, 6, 12, 0, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "early-legacy-consumed",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "consumed",
			consumedAt: new Date(2026, 7, 6, 10, 0, 0).toISOString(),
			updatedAt: new Date(2026, 7, 6, 10, 0, 0).toISOString(),
		});

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "early-legacy-consumed",
				origin: "page",
				now: new Date(2026, 7, 6, 11, 0, 0),
			}),
		).resolves.toEqual({
			valid: false,
			reason: "not-due",
			eligibleAt: dueAt.toISOString(),
		});
	});

	it("preserves retry backoff when a retry agent installation failed", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		const retryAt = new Date(2026, 7, 6, 11, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: "retry-install-error",
			dueAt: dueAt.toISOString(),
			fireAt: retryAt.toISOString(),
			status: "error",
			retryCount: 1,
			retryAt: retryAt.toISOString(),
			installError: "launchctl denied",
			updatedAt: dueAt.toISOString(),
		});

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "24h",
				attemptToken: "retry-install-error",
				origin: "page",
				now: new Date(2026, 7, 6, 11, 0, 0),
			}),
		).resolves.toEqual({
			valid: false,
			reason: "not-due",
			eligibleAt: retryAt.toISOString(),
		});

		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "24h",
				attemptToken: "retry-install-error",
				origin: "page",
				now: retryAt,
			}),
		).resolves.toEqual({ valid: true });
		const running = await readPeriodDigestFreshnessState("24h");
		expect(running).toMatchObject({
			status: "running",
			retryCount: 1,
		});
		expect(running).not.toHaveProperty("pageRecoveryUsedAt");
	});

	it("disables a retry whose retryAt crosses the local day", async () => {
		const dueAt = new Date(2026, 7, 6, 23, 0, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "late-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "running",
			updatedAt: dueAt.toISOString(),
		});
		const install = vi.fn();

		const result = await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "late-token",
			origin: "launchd",
			outcome: "failed",
			now: new Date(2026, 7, 6, 23, 55, 0),
			install,
		});

		expect(result.state).toMatchObject({
			status: "disabled",
			retryCount: 1,
			retryAt: new Date(2026, 7, 7, 0, 10, 0).toISOString(),
		});
		expect(install).not.toHaveBeenCalled();
	});

	it("ignores duplicate completion and completion for a replaced token", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "completed-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "running",
			updatedAt: dueAt.toISOString(),
		});
		const first = await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "completed-token",
			origin: "cli",
			outcome: "published",
			now: new Date(2026, 7, 6, 11, 0, 0),
		});
		const duplicate = await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "completed-token",
			origin: "cli",
			outcome: "published",
			now: new Date(2026, 7, 6, 11, 1, 0),
		});
		await writePeriodDigestFreshnessState({
			...(first.state as PeriodDigestFreshnessStateV1),
			attemptToken: "replacement-token",
			status: "scheduled",
		});
		const replaced = await completePeriodDigestFreshnessAttempt({
			period: "today",
			attemptToken: "completed-token",
			origin: "cli",
			outcome: "failed",
			now: new Date(2026, 7, 6, 11, 2, 0),
		});

		expect(first.updated).toBe(true);
		expect(duplicate.updated).toBe(false);
		expect(replaced.updated).toBe(false);
	});

	it("lets only one concurrent caller move a token to running", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "24h",
			attemptToken: "concurrent-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "scheduled",
			updatedAt: dueAt.toISOString(),
		});
		const input = {
			period: "24h" as const,
			attemptToken: "concurrent-token",
			origin: "launchd" as const,
			now: new Date(2026, 7, 6, 10, 31, 0),
		};
		const runningEligibleAt = new Date(
			input.now.getTime() + 15 * 60_000,
		).toISOString();

		const results = await Promise.all([
			consumePeriodDigestFreshnessAttempt(input),
			consumePeriodDigestFreshnessAttempt(input),
		]);
		expect(results).toEqual(
			expect.arrayContaining([
				{ valid: true },
				{
					valid: false,
					reason: "already-running",
					eligibleAt: runningEligibleAt,
				},
			]),
		);
	});

	it("rejects missing, early, and cross-day freshness attempts", async () => {
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "missing",
				origin: "launchd",
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
				origin: "launchd",
				now: new Date(2026, 7, 6, 11, 0, 0),
			}),
		).resolves.toEqual({
			valid: false,
			reason: "not-due",
			eligibleAt: dueAt.toISOString(),
		});
		await expect(
			consumePeriodDigestFreshnessAttempt({
				period: "today",
				attemptToken: "current",
				origin: "launchd",
				now: new Date(2026, 7, 7, 12, 0, 0),
			}),
		).resolves.toEqual({ valid: false, reason: "cross-day" });
	});

	it("returns the authoritative eligibility time for an early page trigger", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		const retryAt = new Date(2026, 7, 6, 11, 30, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "early-page-token",
			dueAt: dueAt.toISOString(),
			fireAt: retryAt.toISOString(),
			status: "retryable",
			retryCount: 1,
			retryAt: retryAt.toISOString(),
			updatedAt: dueAt.toISOString(),
		});
		const requestRun = vi.fn();

		await expect(
			triggerDuePeriodDigestFreshness({
				period: "today",
				origin: "page",
				now: new Date(2026, 7, 6, 11, 0, 0),
				requestRun,
			}),
		).resolves.toEqual({
			triggered: false,
			reason: "not-due",
			eligibleAt: retryAt.toISOString(),
		});
		expect(requestRun).not.toHaveBeenCalled();
	});

	it("returns the running lease eligibility time for a page trigger", async () => {
		const dueAt = new Date(2026, 7, 6, 10, 30, 0);
		const startedAt = new Date(2026, 7, 6, 10, 31, 0);
		const eligibleAt = new Date(2026, 7, 6, 10, 46, 0);
		await writePeriodDigestFreshnessState({
			schemaVersion: 1,
			period: "today",
			attemptToken: "running-page-token",
			dueAt: dueAt.toISOString(),
			fireAt: dueAt.toISOString(),
			status: "running",
			startedAt: startedAt.toISOString(),
			updatedAt: startedAt.toISOString(),
		});
		const requestRun = vi.fn();

		await expect(
			triggerDuePeriodDigestFreshness({
				period: "today",
				origin: "page",
				now: new Date(2026, 7, 6, 10, 40, 0),
				requestRun,
			}),
		).resolves.toEqual({
			triggered: false,
			reason: "already-running",
			eligibleAt: eligibleAt.toISOString(),
		});
		expect(requestRun).not.toHaveBeenCalled();
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
		const now = new Date(2026, 7, 6, 10, 0, 0);
		const reconciled = await reconcilePeriodDigestFreshness({
			period: "today",
			now,
			freshnessSeconds: 60 * 60,
			schedule: { hour: 8, minute: 0 },
			install: vi.fn(async () => Promise.reject("launchctl denied")),
		});
		expect(reconciled.state).toMatchObject({
			status: "error",
			installError: "launchctl denied",
			updatedAt: now.toISOString(),
		});
	});
});
