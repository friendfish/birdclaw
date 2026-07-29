// @vitest-environment node
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getBirdclawConfig: vi.fn(),
	resolvePeriodDigestWindow: vi.fn(),
	collectPeriodDigestContext: vi.fn(),
	syncHomeTimelineEffect: vi.fn(),
	syncMentionsEffect: vi.fn(),
	syncMentionThreadsEffect: vi.fn(),
}));

vi.mock("./config", () => ({
	getBirdclawConfig: () => mocks.getBirdclawConfig(),
}));

vi.mock("./period-digest", () => ({
	resolvePeriodDigestWindow: (...args: unknown[]) =>
		mocks.resolvePeriodDigestWindow(...args),
	collectPeriodDigestContext: (...args: unknown[]) =>
		mocks.collectPeriodDigestContext(...args),
}));

vi.mock("./timeline-live", () => ({
	syncHomeTimelineEffect: (...args: unknown[]) =>
		mocks.syncHomeTimelineEffect(...args),
}));

vi.mock("./mentions-live", () => ({
	syncMentionsEffect: (...args: unknown[]) => mocks.syncMentionsEffect(...args),
}));

vi.mock("./mention-threads-live", () => ({
	syncMentionThreadsEffect: (...args: unknown[]) =>
		mocks.syncMentionThreadsEffect(...args),
}));

import { runDigestArchivePreSyncEffect } from "./digest-archive-sync";
import { runEffectPromise } from "./effect-runtime";

describe("digest archive pre-sync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getBirdclawConfig.mockReturnValue({
			mentions: { dataSource: "bird" },
		});
		mocks.resolvePeriodDigestWindow.mockReturnValue({
			label: "Yesterday",
			since: "2026-07-28T00:25:00.000Z",
			until: "2026-07-29T00:00:00.000Z",
		});
		mocks.collectPeriodDigestContext.mockReturnValue({
			tweets: [
				{ id: "mention-1", source: "mentions" },
				{ id: "home-1", source: "home" },
			],
		});
		mocks.syncHomeTimelineEffect.mockImplementation(
			(options: { following: boolean }) =>
				Effect.succeed({
					ok: true,
					source: "bird",
					count: options.following ? 10 : 20,
				}),
		);
		mocks.syncMentionsEffect.mockReturnValue(
			Effect.succeed({ ok: true, source: "bird", count: 3 }),
		);
		mocks.syncMentionThreadsEffect.mockReturnValue(
			Effect.succeed({
				ok: true,
				source: "bird",
				uniqueTweets: 4,
				failed: 0,
				partial: false,
			}),
		);
	});

	it("syncs each required input once and in a stable order", async () => {
		const order: string[] = [];
		mocks.syncHomeTimelineEffect.mockImplementation(
			(options: { following: boolean }) => {
				order.push(options.following ? "following" : "for_you");
				return Effect.succeed({
					ok: true,
					source: "bird",
					count: options.following ? 10 : 20,
				});
			},
		);
		mocks.syncMentionsEffect.mockImplementation(() => {
			order.push("mentions");
			return Effect.succeed({ ok: true, source: "bird", count: 3 });
		});
		mocks.syncMentionThreadsEffect.mockImplementation(() => {
			order.push("mention_threads");
			return Effect.succeed({
				ok: true,
				source: "bird",
				uniqueTweets: 4,
				failed: 0,
				partial: false,
			});
		});

		const result = await runEffectPromise(
			runDigestArchivePreSyncEffect({
				period: "yesterday",
				contentSources: ["all", "following", "for_you"],
				liveSync: true,
			}),
		);

		expect(order).toEqual([
			"following",
			"for_you",
			"mentions",
			"mention_threads",
		]);
		expect(result.status).toBe("fresh");
		expect(result.steps.map((step) => step.operation)).toEqual(order);
		expect(mocks.syncHomeTimelineEffect).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				mode: "bird",
				following: true,
				startTime: "2026-07-28T00:00:00.000Z",
				refresh: true,
			}),
		);
		expect(mocks.syncHomeTimelineEffect).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ mode: "bird", following: false }),
		);
		expect(mocks.syncMentionsEffect).toHaveBeenCalledWith(
			expect.not.objectContaining({ startTime: expect.anything() }),
		);
		expect(mocks.syncMentionThreadsEffect).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "bird", tweetIds: ["mention-1"] }),
		);
	});

	it("only syncs the following feed for a following-only batch", async () => {
		const result = await runEffectPromise(
			runDigestArchivePreSyncEffect({
				period: "yesterday",
				contentSources: ["following"],
				liveSync: true,
			}),
		);

		expect(mocks.syncHomeTimelineEffect).toHaveBeenCalledTimes(1);
		expect(mocks.syncHomeTimelineEffect).toHaveBeenCalledWith(
			expect.objectContaining({ following: true }),
		);
		expect(mocks.syncMentionsEffect).not.toHaveBeenCalled();
		expect(mocks.syncMentionThreadsEffect).not.toHaveBeenCalled();
		expect(result.steps.map((step) => step.operation)).toEqual(["following"]);
	});

	it("always uses Bird for a For You-only batch", async () => {
		mocks.getBirdclawConfig.mockReturnValue({
			mentions: { dataSource: "xurl" },
		});

		await runEffectPromise(
			runDigestArchivePreSyncEffect({
				period: "yesterday",
				contentSources: ["for_you"],
				liveSync: true,
			}),
		);

		expect(mocks.syncHomeTimelineEffect).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "bird", following: false }),
		);
		expect(mocks.syncMentionsEffect).not.toHaveBeenCalled();
	});

	it("skips all transports when live sync is disabled", async () => {
		const result = await runEffectPromise(
			runDigestArchivePreSyncEffect({
				period: "yesterday",
				contentSources: ["all", "following", "for_you"],
				liveSync: false,
			}),
		);

		expect(result).toEqual({ status: "skipped", steps: [] });
		expect(mocks.syncHomeTimelineEffect).not.toHaveBeenCalled();
		expect(mocks.syncMentionsEffect).not.toHaveBeenCalled();
		expect(mocks.syncMentionThreadsEffect).not.toHaveBeenCalled();
	});

	it("records a failed operation as degraded and continues", async () => {
		mocks.syncHomeTimelineEffect.mockImplementation(
			(options: { following: boolean }) =>
				options.following
					? Effect.fail(new Error("following transport failed"))
					: Effect.succeed({ ok: true, source: "bird", count: 20 }),
		);

		const result = await runEffectPromise(
			runDigestArchivePreSyncEffect({
				period: "yesterday",
				contentSources: ["all", "following", "for_you"],
				liveSync: true,
			}),
		);

		expect(result.status).toBe("degraded");
		expect(result.steps[0]).toEqual({
			operation: "following",
			status: "degraded",
			transport: "bird",
			error: "following transport failed",
		});
		expect(mocks.syncMentionThreadsEffect).toHaveBeenCalledTimes(1);
	});

	it("treats partial or per-thread failures as degraded", async () => {
		mocks.syncMentionThreadsEffect.mockReturnValue(
			Effect.succeed({
				ok: true,
				source: "bird",
				uniqueTweets: 2,
				failed: 1,
				partial: true,
			}),
		);

		const result = await runEffectPromise(
			runDigestArchivePreSyncEffect({
				period: "yesterday",
				contentSources: ["all"],
				liveSync: true,
			}),
		);

		expect(result.status).toBe("degraded");
		expect(result.steps.at(-1)).toEqual({
			operation: "mention_threads",
			status: "degraded",
			transport: "bird",
			count: 2,
			error: "1 mention thread fetch failed; thread context is partial",
		});
	});
});
