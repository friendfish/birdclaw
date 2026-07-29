// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getLiveDataSourcesEffect } from "./data-sources";

const mocks = vi.hoisted(() => ({
	getAuthenticatedBirdAccount: vi.fn(),
	getTransportStatus: vi.fn(),
	lookupAuthenticatedOAuth2User: vi.fn(),
	readXurlOAuth2Accounts: vi.fn(),
}));

vi.mock("./bird", async () => {
	const { effectFromMock: fromMock } = await import("../test/effect-mocks");
	return {
		getAuthenticatedBirdAccountEffect: fromMock(
			mocks.getAuthenticatedBirdAccount,
		),
	};
});

vi.mock("./db", () => ({
	getNativeDb: () => ({
		prepare: () => ({ all: () => [] }),
	}),
}));

vi.mock("./xurl", async () => {
	const { effectFromMock: fromMock } = await import("../test/effect-mocks");
	return {
		getTransportStatusEffect: fromMock(mocks.getTransportStatus),
		lookupAuthenticatedOAuth2UserEffect: fromMock(
			mocks.lookupAuthenticatedOAuth2User,
		),
		readXurlOAuth2AccountsEffect: fromMock(mocks.readXurlOAuth2Accounts),
	};
});

const envKeys = [
	"BIRDCLAW_HOME",
	"BIRDCLAW_CONFIG",
	"BIRDCLAW_MENTIONS_DATA_SOURCE",
] as const;
const envSnapshot = new Map(
	envKeys.map((key) => [key, process.env[key]] as const),
);

function clearLiveSourceEnvironment() {
	for (const key of envKeys) {
		delete process.env[key];
	}
	resetBirdclawPathsForTests();
}

function restoreLiveSourceEnvironment() {
	for (const key of envKeys) {
		const value = envSnapshot.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	resetBirdclawPathsForTests();
}

describe("live data sources", () => {
	beforeEach(() => {
		clearLiveSourceEnvironment();
		mocks.getAuthenticatedBirdAccount.mockReset();
		mocks.getTransportStatus.mockReset();
		mocks.lookupAuthenticatedOAuth2User.mockReset();
		mocks.readXurlOAuth2Accounts.mockReset();
		mocks.getAuthenticatedBirdAccount.mockResolvedValue({
			id: "1",
			username: "steipete",
		});
	});

	afterEach(() => {
		restoreLiveSourceEnvironment();
	});

	it("does not probe xurl while Bird is the configured live source", async () => {
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "bird";
		resetBirdclawPathsForTests();

		const result = await Effect.runPromise(getLiveDataSourcesEffect());

		expect(result.sources).toContainEqual(
			expect.objectContaining({
				source: "xurl",
				works: false,
				detail: "xurl disabled by bird transport selection",
			}),
		);
		expect(mocks.getTransportStatus).not.toHaveBeenCalled();
		expect(mocks.lookupAuthenticatedOAuth2User).not.toHaveBeenCalled();
		expect(mocks.readXurlOAuth2Accounts).not.toHaveBeenCalled();
	});

	it.each(["xurl", "auto"])(
		"keeps xurl status and account probes for a %s live source",
		async (liveSource) => {
			process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = liveSource;
			resetBirdclawPathsForTests();
			mocks.getTransportStatus.mockResolvedValue({
				installed: true,
				availableTransport: "xurl",
				statusText: "xurl available",
			});
			mocks.lookupAuthenticatedOAuth2User.mockResolvedValue({
				id: "1",
				username: "steipete",
			});
			mocks.readXurlOAuth2Accounts.mockResolvedValue([]);

			await Effect.runPromise(getLiveDataSourcesEffect());

			expect(mocks.getTransportStatus).toHaveBeenCalledTimes(1);
			expect(mocks.lookupAuthenticatedOAuth2User).toHaveBeenCalledTimes(1);
			expect(mocks.readXurlOAuth2Accounts).toHaveBeenCalledTimes(1);
		},
	);
});
