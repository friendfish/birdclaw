// @vitest-environment node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import type {
	PeriodDigestContentSource,
	PeriodDigestContext,
	PeriodDigestRunResult,
} from "./period-digest";
import {
	publishCurrentPeriodDigest,
	readCurrentPeriodDigest,
} from "./period-digest-current-store";
import {
	readPeriodDigestRunState,
	requestPeriodDigestRun,
	periodDigestRunLockPath,
	periodDigestRunStatePath,
	type PeriodDigestOrchestratorDependencies,
} from "./period-digest-orchestrator";

const testHome = useTestHome({ prefix: "birdclaw-period-orchestrator-" });

function context(
	period: "today" | "24h",
	contentSource: PeriodDigestContentSource,
): PeriodDigestContext {
	return {
		window: {
			label: period === "today" ? "Today" : "Last 24 hours",
			since: "2026-08-06T00:00:00.000Z",
			until: "2026-08-06T08:00:00.000Z",
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
}

function result(
	period: "today" | "24h",
	contentSource: PeriodDigestContentSource,
	updatedAt = "2026-08-06T08:30:00.000Z",
): PeriodDigestRunResult {
	return {
		context: context(period, contentSource),
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
		updatedAt,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function dependencies(
	overrides: Partial<PeriodDigestOrchestratorDependencies> = {},
): PeriodDigestOrchestratorDependencies {
	return {
		now: () => new Date("2026-08-06T08:30:00.000Z"),
		randomId: randomUUID,
		preSync: vi.fn(async () => ({ status: "fresh" as const, steps: [] })),
		collectContext: vi.fn(({ period, contentSource }) =>
			context(period, contentSource),
		),
		generate: vi.fn(async ({ period, contentSource }) =>
			result(period, contentSource),
		),
		readCredentials: vi.fn(() => ({ authToken: "auth", ct0: "ct0" })),
		reconcileFreshness: vi.fn(async () => undefined),
		audit: vi.fn(async () => undefined),
		heartbeatIntervalMs: 60_000,
		maxGenerateAttempts: 1,
		retryDelayMs: 0,
		...overrides,
	};
}

describe("period digest orchestrator", () => {
	it("joins scheduled, freshness, and manual collisions into the owner's batch", async () => {
		const gate = deferred<PeriodDigestRunResult>();
		const generate = vi.fn(
			async ({
				period,
				contentSource,
			}: Parameters<PeriodDigestOrchestratorDependencies["generate"]>[0]) => {
				if (contentSource === "for_you") return gate.promise;
				return result(period, contentSource);
			},
		);
		const deps = dependencies({ generate });

		const owner = await requestPeriodDigestRun(
			{
				period: "today",
				trigger: "manual",
				origin: "page",
				requestedSource: "for_you",
			},
			deps,
		);
		const scheduled = await requestPeriodDigestRun(
			{ period: "today", trigger: "scheduled", origin: "launchd" },
			deps,
		);
		const freshness = await requestPeriodDigestRun(
			{ period: "today", trigger: "freshness", origin: "cli" },
			deps,
		);

		expect(owner.joined).toBe(false);
		expect(scheduled).toMatchObject({ joined: true, runId: owner.runId });
		expect(freshness).toMatchObject({ joined: true, runId: owner.runId });
		expect(generate).toHaveBeenCalledTimes(1);
		let state = await readPeriodDigestRunState("today");
		const rawState = JSON.parse(
			await fs.readFile(periodDigestRunStatePath("today"), "utf8"),
		) as { joinedBy: unknown[] };
		expect(state).toMatchObject({
			runId: owner.runId,
			startedBy: { trigger: "manual", origin: "page" },
			prioritySource: "for_you",
			currentSource: "for_you",
		});
		expect(state?.joinedBy).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					trigger: "scheduled",
					origin: "launchd",
				}),
				expect.objectContaining({ trigger: "freshness", origin: "cli" }),
			]),
		);

		gate.resolve(result("today", "for_you"));
		state = await owner.completion;
		await Promise.all([scheduled.completion, freshness.completion]);
		expect(rawState.joinedBy).toEqual([]);
		expect(state.phase).toBe("completed");
		expect(generate.mock.calls.map(([input]) => input.contentSource)).toEqual([
			"for_you",
			"all",
			"following",
		]);
		expect(deps.preSync).toHaveBeenCalledTimes(1);
		expect(deps.readCredentials).toHaveBeenCalledTimes(1);
	});

	it("joins a terminal run while its owner is still finalizing", async () => {
		const finalization = deferred<unknown>();
		const deps = dependencies({
			reconcileFreshness: vi.fn(() => finalization.promise),
		});
		const owner = await requestPeriodDigestRun(
			{ period: "today", trigger: "scheduled", origin: "launchd" },
			deps,
		);
		let terminal = await readPeriodDigestRunState("today");
		for (
			let attempt = 0;
			terminal?.phase !== "completed" && attempt < 50;
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 2));
			terminal = await readPeriodDigestRunState("today");
		}
		expect(terminal?.phase).toBe("completed");

		const collision = await requestPeriodDigestRun(
			{ period: "today", trigger: "manual", origin: "page" },
			deps,
		);
		expect(collision).toMatchObject({ joined: true, runId: owner.runId });
		await expect(collision.completion).resolves.toMatchObject({
			runId: owner.runId,
			phase: "completed",
		});

		finalization.resolve(undefined);
		await owner.completion;
	});

	it("bounds a joiner's wait when the owner never reaches a terminal state", async () => {
		const gate = deferred<PeriodDigestRunResult>();
		const deps = dependencies({
			generate: vi.fn(() => gate.promise),
			completionWaitTimeoutMs: 10,
			completionPollIntervalMs: 1,
		});
		const owner = await requestPeriodDigestRun(
			{ period: "24h", trigger: "scheduled", origin: "launchd" },
			deps,
		);
		const joiner = await requestPeriodDigestRun(
			{ period: "24h", trigger: "manual", origin: "page" },
			deps,
		);
		const outcome = await Promise.race([
			joiner.completion.then(
				() => "resolved",
				() => "rejected",
			),
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("external-timeout"), 50),
			),
		]);

		gate.resolve(result("24h", "all"));
		await owner.completion;
		await joiner.completion.catch(() => undefined);
		expect(outcome).toBe("rejected");
	});

	it("aborts the batch and skips later sources after losing its lease", async () => {
		const publish = vi.fn();
		const generate = vi.fn(
			async ({
				signal,
			}: Parameters<PeriodDigestOrchestratorDependencies["generate"]>[0]) => {
				await fs.rm(periodDigestRunLockPath("today"), { force: true });
				return new Promise<PeriodDigestRunResult>((_resolve, reject) => {
					const fallback = setTimeout(
						() => reject(new Error("model did not observe owner cancellation")),
						50,
					);
					if (signal?.aborted) {
						clearTimeout(fallback);
						reject(signal.reason);
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(fallback);
							reject(signal.reason);
						},
						{ once: true },
					);
				});
			},
		);
		const run = await requestPeriodDigestRun(
			{ period: "today", trigger: "scheduled", origin: "launchd" },
			dependencies({
				generate,
				publish,
				heartbeatIntervalMs: 2,
			}),
		);

		await expect(run.completion).resolves.toMatchObject({
			phase: "failed",
			error: expect.stringContaining("lease ownership was lost"),
		});
		expect(generate).toHaveBeenCalledTimes(1);
		expect(publish).not.toHaveBeenCalled();
	});

	it("freezes all source contexts before the first sequential generation", async () => {
		const events: string[] = [];
		let activeModels = 0;
		let maxActiveModels = 0;
		const deps = dependencies({
			preSync: vi.fn(async () => {
				events.push("sync");
				return { status: "degraded" as const, steps: [] };
			}),
			collectContext: vi.fn(({ period, contentSource }) => {
				events.push(`context:${contentSource}`);
				return context(period, contentSource);
			}),
			generate: vi.fn(async ({ period, contentSource, context: frozen }) => {
				events.push(`generate:${contentSource}`);
				expect(frozen.contentSource).toBe(contentSource);
				activeModels += 1;
				maxActiveModels = Math.max(maxActiveModels, activeModels);
				await Promise.resolve();
				activeModels -= 1;
				return result(period, contentSource);
			}),
		});

		const run = await requestPeriodDigestRun(
			{ period: "24h", trigger: "scheduled", origin: "launchd" },
			deps,
		);
		const finalState = await run.completion;

		expect(events).toEqual([
			"sync",
			"context:all",
			"context:following",
			"context:for_you",
			"generate:all",
			"generate:following",
			"generate:for_you",
		]);
		expect(maxActiveModels).toBe(1);
		expect(finalState.phase).toBe("degraded");
	});

	it("keeps a failed source's old result and publishes later successes", async () => {
		const { db } = testHome();
		publishCurrentPeriodDigest(
			{
				period: "today",
				contentSource: "all",
				runId: "old-run",
				versionId: "old-version",
				generatedAt: "2026-08-06T06:00:00.000Z",
				result: result("today", "all", "2026-08-06T06:00:00.000Z"),
				maxTweets: 2_500,
				maxLinks: 12,
				sync: { status: "fresh", steps: [] },
			},
			db,
		);
		const deps = dependencies({
			generate: vi.fn(async ({ period, contentSource }) => {
				if (contentSource === "all") throw new Error("model timeout");
				return result(period, contentSource, "2026-08-06T08:30:00.000Z");
			}),
			database: db,
		});

		const run = await requestPeriodDigestRun(
			{ period: "today", trigger: "freshness", origin: "launchd" },
			deps,
		);
		const finalState = await run.completion;

		expect(finalState.phase).toBe("degraded");
		expect(finalState.sources.all).toMatchObject({
			state: "failed",
			error: "model timeout",
		});
		expect(readCurrentPeriodDigest("today", "all", db)).toMatchObject({
			versionId: "old-version",
			generatedAt: "2026-08-06T06:00:00.000Z",
		});
		expect(readCurrentPeriodDigest("today", "following", db)).toMatchObject({
			generatedAt: "2026-08-06T08:30:00.000Z",
			contentSource: "following",
		});
		expect(readCurrentPeriodDigest("today", "for_you", db)).toMatchObject({
			generatedAt: "2026-08-06T08:30:00.000Z",
			contentSource: "for_you",
		});
		expect(deps.reconcileFreshness).toHaveBeenCalledWith("today", {
			suppressSources: ["all"],
		});
	});

	it("retries a source within the same batch and records the successful attempt", async () => {
		let allAttempts = 0;
		const sleep = vi.fn(async () => undefined);
		const deps = dependencies({
			maxGenerateAttempts: 3,
			retryDelayMs: 25,
			sleep,
			generate: vi.fn(async ({ period, contentSource }) => {
				if (contentSource === "all" && ++allAttempts === 1) {
					throw new Error("temporary model failure");
				}
				return result(period, contentSource);
			}),
		});

		const run = await requestPeriodDigestRun(
			{ period: "today", trigger: "scheduled", origin: "launchd" },
			deps,
		);
		const finalState = await run.completion;

		expect(finalState.phase).toBe("completed");
		expect(finalState.sources.all).toMatchObject({
			state: "completed",
			attempts: 2,
		});
		expect(sleep).toHaveBeenCalledWith(25);
		expect(deps.reconcileFreshness).toHaveBeenCalledWith("today");
		expect(deps.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "completed",
				startedBy: { trigger: "scheduled", origin: "launchd" },
			}),
		);
	});

	it("rejects a requested source on non-manual triggers", async () => {
		await expect(
			requestPeriodDigestRun(
				{
					period: "today",
					trigger: "scheduled",
					origin: "launchd",
					requestedSource: "all",
				},
				dependencies(),
			),
		).rejects.toThrow("requestedSource is only valid for manual digest runs");
	});

	it("records pre-sync failures without clearing an existing run state", async () => {
		const audit = vi.fn(async () =>
			Promise.reject(new Error("audit unavailable")),
		);
		const deps = dependencies({
			preSync: vi.fn(async () => Promise.reject(new Error("sync unavailable"))),
			audit,
		});

		const run = await requestPeriodDigestRun(
			{
				period: "24h",
				trigger: "freshness",
				origin: "cli",
				liveSync: false,
			},
			deps,
		);
		const finalState = await run.completion;

		expect(finalState).toMatchObject({
			phase: "failed",
			error: "sync unavailable",
			sync: { status: "skipped" },
		});
		expect(deps.readCredentials).not.toHaveBeenCalled();
		expect(audit).toHaveBeenCalledOnce();
	});

	it("marks a batch failed when every source generation fails", async () => {
		const deps = dependencies({
			generate: vi.fn(async () =>
				Promise.reject(new Error("model unavailable")),
			),
			reconcileFreshness: vi.fn(async () =>
				Promise.reject(new Error("unused")),
			),
		});

		const run = await requestPeriodDigestRun(
			{ period: "today", trigger: "scheduled", origin: "launchd" },
			deps,
		);
		const finalState = await run.completion;

		expect(finalState.phase).toBe("failed");
		expect(Object.values(finalState.sources)).toEqual([
			expect.objectContaining({ state: "failed", attempts: 1 }),
			expect.objectContaining({ state: "failed", attempts: 1 }),
			expect.objectContaining({ state: "failed", attempts: 1 }),
		]);
		expect(deps.reconcileFreshness).not.toHaveBeenCalled();
	});

	it("forwards account and language while tolerating post-publication hook failures", async () => {
		const deps = dependencies({
			reconcileFreshness: vi.fn(async () =>
				Promise.reject(new Error("scheduler unavailable")),
			),
			audit: vi.fn(async () => Promise.reject(new Error("audit unavailable"))),
		});

		const run = await requestPeriodDigestRun(
			{
				period: "today",
				trigger: "manual",
				origin: "cli",
				account: "alice",
				language: "zh-CN",
				liveSync: false,
			},
			deps,
		);
		const finalState = await run.completion;

		expect(finalState.phase).toBe("completed");
		expect(deps.preSync).toHaveBeenCalledWith(
			expect.objectContaining({ account: "alice", liveSync: false }),
		);
		expect(deps.collectContext).toHaveBeenCalledWith(
			expect.objectContaining({ account: "alice" }),
		);
		expect(deps.generate).toHaveBeenCalledWith(
			expect.objectContaining({ account: "alice", language: "zh-CN" }),
		);
		expect(deps.reconcileFreshness).toHaveBeenCalledWith("today");
		expect(deps.audit).toHaveBeenCalledOnce();
	});

	it("ignores corrupt and incompatible persisted run states", async () => {
		const deps = dependencies();
		const run = await requestPeriodDigestRun(
			{ period: "24h", trigger: "scheduled", origin: "launchd" },
			deps,
		);
		const valid = await run.completion;
		const statePath = periodDigestRunStatePath("24h");
		await fs.mkdir(path.dirname(statePath), { recursive: true });

		await fs.writeFile(statePath, "{not-json", "utf8");
		await expect(readPeriodDigestRunState("24h")).resolves.toBeUndefined();

		const invalidStates: unknown[] = [
			null,
			[],
			{ ...valid, schemaVersion: 2 },
			{ ...valid, runId: 1 },
			{ ...valid, period: "week" },
			{ ...valid, startedBy: undefined },
			{ ...valid, startedBy: { trigger: "unknown", origin: "launchd" } },
			{ ...valid, startedBy: { trigger: "scheduled", origin: "unknown" } },
			{ ...valid, joinedBy: null },
			{ ...valid, sourceOrder: null },
			{ ...valid, sourceOrder: ["unknown"] },
			{ ...valid, ownerId: 1 },
			{ ...valid, pid: "pid" },
			{ ...valid, host: 1 },
			{ ...valid, startedAt: 1 },
			{ ...valid, heartbeatAt: 1 },
			{ ...valid, phase: 1 },
			{ ...valid, sources: null },
		];

		for (const invalid of invalidStates) {
			await fs.writeFile(statePath, JSON.stringify(invalid), "utf8");
			await expect(readPeriodDigestRunState("24h")).resolves.toBeUndefined();
		}

		const validCliOrigin = {
			...valid,
			startedBy: { trigger: "manual" as const, origin: "cli" as const },
		};
		await fs.writeFile(statePath, JSON.stringify(validCliOrigin), "utf8");
		await expect(readPeriodDigestRunState("24h")).resolves.toMatchObject({
			startedBy: { trigger: "manual", origin: "cli" },
		});
	});
});
