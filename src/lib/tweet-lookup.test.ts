// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";

const mocks = vi.hoisted(() => ({
	lookupTweetsByIdsViaBird: vi.fn(),
	lookupTweetsByIdsViaXurl: vi.fn(),
}));
const originalLiveDataSource = process.env.BIRDCLAW_LIVE_DATA_SOURCE;
const originalMentionsDataSource = process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;

vi.mock("./bird", () => ({
	lookupTweetsByIdsViaBird: mocks.lookupTweetsByIdsViaBird,
	lookupTweetsByIdsViaBirdEffect: (ids: string[]) =>
		Effect.tryPromise({
			try: () => mocks.lookupTweetsByIdsViaBird(ids),
			catch: (error) => error,
		}),
}));

vi.mock("./xurl", async () => {
	const { Effect } = await import("effect");
	return {
		lookupTweetsByIds: mocks.lookupTweetsByIdsViaXurl,
		lookupTweetsByIdsEffect: (ids: string[]) =>
			Effect.tryPromise({
				try: () => mocks.lookupTweetsByIdsViaXurl(ids),
				catch: (error) =>
					error instanceof Error ? error : new Error(String(error)),
			}),
	};
});

describe("shared tweet lookup", () => {
	beforeEach(() => {
		delete process.env.BIRDCLAW_LIVE_DATA_SOURCE;
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "birdclaw";
		resetBirdclawPathsForTests();
	});

	afterEach(() => {
		vi.resetModules();
		for (const mock of Object.values(mocks)) {
			mock.mockReset();
		}
		if (originalLiveDataSource === undefined) {
			delete process.env.BIRDCLAW_LIVE_DATA_SOURCE;
		} else {
			process.env.BIRDCLAW_LIVE_DATA_SOURCE = originalLiveDataSource;
		}
		if (originalMentionsDataSource === undefined) {
			delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
		} else {
			process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = originalMentionsDataSource;
		}
		resetBirdclawPathsForTests();
	});

	it("uses xurl first in auto mode", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockResolvedValue({
			data: [
				{ id: "tweet_1", author_id: "42", text: "xurl", created_at: "now" },
			],
		});
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await expect(lookupTweetsByIds(["tweet_1"])).resolves.toMatchObject({
			data: [{ id: "tweet_1", text: "xurl" }],
		});
		expect(mocks.lookupTweetsByIdsViaXurl).toHaveBeenCalledWith(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaBird).not.toHaveBeenCalled();
	});

	it("uses Bird without probing xurl when omitted mode resolves to Bird", async () => {
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
		resetBirdclawPathsForTests();
		mocks.lookupTweetsByIdsViaXurl.mockResolvedValue({
			data: [
				{ id: "tweet_1", author_id: "42", text: "xurl", created_at: "now" },
			],
		});
		mocks.lookupTweetsByIdsViaBird.mockResolvedValue({
			data: [
				{ id: "tweet_1", author_id: "42", text: "bird", created_at: "now" },
			],
		});
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await expect(lookupTweetsByIds(["tweet_1"])).resolves.toMatchObject({
			data: [{ id: "tweet_1", text: "bird" }],
		});
		expect(mocks.lookupTweetsByIdsViaBird).toHaveBeenCalledWith(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaXurl).not.toHaveBeenCalled();
	});

	it("exposes tweet lookup as a lazy Effect program", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockResolvedValue({
			data: [
				{ id: "tweet_1", author_id: "42", text: "xurl", created_at: "now" },
			],
		});
		const { lookupTweetsByIdsEffect } = await import("./tweet-lookup");

		const effect = lookupTweetsByIdsEffect(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaXurl).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			data: [{ id: "tweet_1", text: "xurl" }],
		});
	});

	it("falls back to bird when xurl lookup fails in auto mode", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockRejectedValue(new Error("xurl 401"));
		mocks.lookupTweetsByIdsViaBird.mockResolvedValue({
			data: [
				{
					id: "tweet_1",
					author_id: "42",
					text: "bird",
					created_at: "now",
					referenced_tweets: [{ type: "replied_to", id: "tweet_root" }],
				},
			],
		});
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await expect(lookupTweetsByIds(["tweet_1"])).resolves.toMatchObject({
			data: [
				{
					id: "tweet_1",
					text: "bird",
					referenced_tweets: [{ type: "replied_to", id: "tweet_root" }],
				},
			],
		});
		expect(mocks.lookupTweetsByIdsViaXurl).toHaveBeenCalledWith(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaBird).toHaveBeenCalledWith(["tweet_1"]);
	});

	it("honors explicit transport modes", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockResolvedValue({ data: [] });
		mocks.lookupTweetsByIdsViaBird.mockResolvedValue({ data: [] });
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await lookupTweetsByIds(["tweet_1"], "xurl");
		await lookupTweetsByIds(["tweet_2"], "bird");

		expect(mocks.lookupTweetsByIdsViaXurl).toHaveBeenCalledWith(["tweet_1"]);
		expect(mocks.lookupTweetsByIdsViaBird).toHaveBeenCalledWith(["tweet_2"]);
	});

	it("rejects an invalid explicit mode before constructing a transport plan", async () => {
		const { lookupTweetsByIdsEffect } = await import("./tweet-lookup");

		expect(() =>
			lookupTweetsByIdsEffect(["tweet_1"], "invalid" as "auto"),
		).toThrow("Invalid live-read mode; expected auto, bird, or xurl");
		expect(mocks.lookupTweetsByIdsViaXurl).not.toHaveBeenCalled();
		expect(mocks.lookupTweetsByIdsViaBird).not.toHaveBeenCalled();
	});

	it("reports both transport failures in auto mode", async () => {
		mocks.lookupTweetsByIdsViaXurl.mockRejectedValue("xurl offline");
		mocks.lookupTweetsByIdsViaBird.mockRejectedValue(new Error("bird offline"));
		const { lookupTweetsByIds } = await import("./tweet-lookup");

		await expect(lookupTweetsByIds(["tweet_1"])).rejects.toThrow(
			"Tweet lookup failed via xurl and bird: xurl: xurl offline; bird: bird offline",
		);
	});
});
