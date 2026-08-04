// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDigestArchiveRunState,
	readDigestArchiveRunState,
	removeDigestArchiveRunState,
	startDigestArchiveHeartbeat,
	updateDigestArchiveRunState,
	writeDigestArchiveRunState,
} from "./digest-archive-run-state";

const tempDirs: string[] = [];

function makeStatePath() {
	const directory = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-digest-run-state-"),
	);
	tempDirs.push(directory);
	return path.join(directory, "runs", "digest-archive-today.json");
}

afterEach(() => {
	vi.useRealTimers();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("digest archive run state", () => {
	it("writes source transitions atomically and protects owner cleanup", async () => {
		const statePath = makeStatePath();
		const state = createDigestArchiveRunState({
			period: "today",
			runDate: "2026-08-04",
			ownerId: "owner-1",
			contentSources: ["all", "following", "for_you"],
			now: new Date("2026-08-04T00:00:00.000Z"),
		});

		await writeDigestArchiveRunState(statePath, state);
		await updateDigestArchiveRunState(
			statePath,
			"owner-1",
			(current) => ({
				...current,
				phase: "generating",
				currentSource: "all",
				sources: {
					...current.sources,
					all: { state: "running", attempts: 1 },
				},
			}),
			new Date("2026-08-04T00:00:15.000Z"),
		);

		await expect(readDigestArchiveRunState(statePath)).resolves.toMatchObject({
			ownerId: "owner-1",
			phase: "generating",
			currentSource: "all",
			lastHeartbeatAt: "2026-08-04T00:00:15.000Z",
			sources: {
				all: { state: "running", attempts: 1 },
				following: { state: "pending", attempts: 0 },
				for_you: { state: "pending", attempts: 0 },
			},
		});

		await removeDigestArchiveRunState(statePath, "other-owner");
		expect(existsSync(statePath)).toBe(true);
		await removeDigestArchiveRunState(statePath, "owner-1");
		expect(existsSync(statePath)).toBe(false);
	});

	it("heartbeats while awake and stops without another write", async () => {
		vi.useFakeTimers();
		const statePath = makeStatePath();
		const state = createDigestArchiveRunState({
			period: "today",
			runDate: "2026-08-04",
			ownerId: "owner-2",
			contentSources: ["all"],
			now: new Date("2026-08-04T00:00:00.000Z"),
		});
		await writeDigestArchiveRunState(statePath, state);
		let now = new Date("2026-08-04T00:00:15.000Z");
		const onHeartbeat = vi.fn(async () => true);
		const heartbeat = startDigestArchiveHeartbeat({
			statePath,
			ownerId: "owner-2",
			intervalMs: 15_000,
			now: () => now,
			onHeartbeat,
		});

		await vi.advanceTimersByTimeAsync(15_000);
		await heartbeat.stop();
		await expect(readDigestArchiveRunState(statePath)).resolves.toMatchObject({
			lastHeartbeatAt: "2026-08-04T00:00:15.000Z",
		});
		expect(onHeartbeat).toHaveBeenCalledTimes(1);

		now = new Date("2026-08-04T00:00:30.000Z");
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(readDigestArchiveRunState(statePath)).resolves.toMatchObject({
			lastHeartbeatAt: "2026-08-04T00:00:15.000Z",
		});
	});

	it("signals when a lock heartbeat reports lost ownership", async () => {
		vi.useFakeTimers();
		const statePath = makeStatePath();
		await writeDigestArchiveRunState(
			statePath,
			createDigestArchiveRunState({
				period: "today",
				runDate: "2026-08-04",
				ownerId: "owner-lost",
				contentSources: ["all"],
			}),
		);
		const heartbeat = startDigestArchiveHeartbeat({
			statePath,
			ownerId: "owner-lost",
			intervalMs: 1_000,
			onHeartbeat: async () => false,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(heartbeat.lost).resolves.toBeUndefined();
		await heartbeat.stop();
	});

	it("serializes concurrent mutations so heartbeats cannot erase progress", async () => {
		const statePath = makeStatePath();
		await writeDigestArchiveRunState(
			statePath,
			createDigestArchiveRunState({
				period: "today",
				runDate: "2026-08-04",
				ownerId: "owner-concurrent",
				contentSources: ["all"],
				now: new Date("2026-08-04T00:00:00.000Z"),
			}),
		);

		await Promise.all([
			updateDigestArchiveRunState(
				statePath,
				"owner-concurrent",
				(state) => ({ ...state, phase: "generating" }),
				new Date("2026-08-04T00:00:15.000Z"),
			),
			updateDigestArchiveRunState(
				statePath,
				"owner-concurrent",
				(state) => ({
					...state,
					currentSource: "all",
					sources: {
						...state.sources,
						all: { state: "running", attempts: 1 },
					},
				}),
				new Date("2026-08-04T00:00:16.000Z"),
			),
		]);

		await expect(readDigestArchiveRunState(statePath)).resolves.toMatchObject({
			phase: "generating",
			currentSource: "all",
			sources: { all: { state: "running", attempts: 1 } },
			lastHeartbeatAt: "2026-08-04T00:00:16.000Z",
		});
	});
});
