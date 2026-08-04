import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBirdclawPaths } from "./config";
import type {
	PeriodDigestContentSource,
	PeriodDigestPreset,
} from "./period-digest";

export type DigestRunPhase = "pre-sync" | "generating" | "finalizing";
export type DigestSourceState = "pending" | "running" | "completed" | "failed";

export interface DigestArchiveSourceRunState {
	state: DigestSourceState;
	attempts: number;
	generatedAt?: string;
	error?: string;
}

export interface DigestArchiveRunStateV1 {
	schemaVersion: 1;
	ownerId: string;
	period: PeriodDigestPreset;
	pid: number;
	host: string;
	runDate: string;
	startedAt: string;
	lastHeartbeatAt: string;
	phase: DigestRunPhase;
	currentSource?: PeriodDigestContentSource;
	totalSources: number;
	sources: Partial<
		Record<PeriodDigestContentSource, DigestArchiveSourceRunState>
	>;
}

const mutationQueues = new Map<string, Promise<void>>();

function serializeStateMutation<T>(
	statePath: string,
	mutation: () => Promise<T>,
) {
	const previous = mutationQueues.get(statePath) ?? Promise.resolve();
	const operation = previous.then(mutation);
	const tail = operation.then(
		() => undefined,
		() => undefined,
	);
	mutationQueues.set(statePath, tail);
	return operation.finally(() => {
		if (mutationQueues.get(statePath) === tail) {
			mutationQueues.delete(statePath);
		}
	});
}

export function digestArchiveRunStatePath(period: PeriodDigestPreset) {
	return path.join(
		getBirdclawPaths().rootDir,
		"runs",
		`digest-archive-${period}.json`,
	);
}

export function createDigestArchiveRunState({
	period,
	runDate,
	contentSources,
	ownerId = randomUUID(),
	now = new Date(),
	pid = process.pid,
	host = os.hostname(),
}: {
	period: PeriodDigestPreset;
	runDate: string;
	contentSources: PeriodDigestContentSource[];
	ownerId?: string;
	now?: Date;
	pid?: number;
	host?: string;
}): DigestArchiveRunStateV1 {
	const timestamp = now.toISOString();
	return {
		schemaVersion: 1,
		ownerId,
		period,
		pid,
		host,
		runDate,
		startedAt: timestamp,
		lastHeartbeatAt: timestamp,
		phase: "pre-sync",
		totalSources: contentSources.length,
		sources: Object.fromEntries(
			contentSources.map((contentSource) => [
				contentSource,
				{ state: "pending", attempts: 0 },
			]),
		),
	};
}

async function writeJsonAtomically(
	statePath: string,
	state: DigestArchiveRunStateV1,
) {
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(state, null, "\t")}\n`,
			"utf8",
		);
		await fs.rename(temporaryPath, statePath);
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export function writeDigestArchiveRunState(
	statePath: string,
	state: DigestArchiveRunStateV1,
) {
	return serializeStateMutation(statePath, () =>
		writeJsonAtomically(statePath, state),
	);
}

export async function readDigestArchiveRunState(
	statePath: string,
): Promise<DigestArchiveRunStateV1 | undefined> {
	const raw = await fs.readFile(statePath, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	try {
		const state = JSON.parse(raw) as Partial<DigestArchiveRunStateV1>;
		if (
			state.schemaVersion !== 1 ||
			typeof state.ownerId !== "string" ||
			typeof state.period !== "string" ||
			typeof state.pid !== "number" ||
			typeof state.host !== "string" ||
			typeof state.runDate !== "string" ||
			typeof state.startedAt !== "string" ||
			typeof state.lastHeartbeatAt !== "string" ||
			typeof state.phase !== "string" ||
			typeof state.totalSources !== "number" ||
			typeof state.sources !== "object" ||
			state.sources === null
		) {
			return undefined;
		}
		return state as DigestArchiveRunStateV1;
	} catch {
		return undefined;
	}
}

export async function updateDigestArchiveRunState(
	statePath: string,
	ownerId: string,
	update: (state: DigestArchiveRunStateV1) => DigestArchiveRunStateV1,
	now = new Date(),
) {
	return serializeStateMutation(statePath, async () => {
		const current = await readDigestArchiveRunState(statePath);
		if (!current || current.ownerId !== ownerId) return undefined;
		const next = {
			...update(current),
			ownerId,
			lastHeartbeatAt: now.toISOString(),
		} satisfies DigestArchiveRunStateV1;
		await writeJsonAtomically(statePath, next);
		return next;
	});
}

export async function removeDigestArchiveRunState(
	statePath: string,
	ownerId: string,
) {
	await serializeStateMutation(statePath, async () => {
		const current = await readDigestArchiveRunState(statePath);
		if (!current || current.ownerId !== ownerId) return;
		await fs.rm(statePath, { force: true });
	});
}

export function startDigestArchiveHeartbeat({
	statePath,
	ownerId,
	intervalMs = 15_000,
	now = () => new Date(),
	onHeartbeat,
}: {
	statePath: string;
	ownerId: string;
	intervalMs?: number;
	now?: () => Date;
	onHeartbeat?: () => Promise<unknown>;
}) {
	let pending = Promise.resolve<unknown>(undefined);
	let signalLost: (() => void) | undefined;
	const lost = new Promise<void>((resolve) => {
		signalLost = resolve;
	});
	const heartbeat = () => {
		pending = pending
			.then(async () => {
				await updateDigestArchiveRunState(
					statePath,
					ownerId,
					(state) => state,
					now(),
				).catch(() => undefined);
				const lockRetained = await onHeartbeat?.().catch(() => undefined);
				if (lockRetained === false) signalLost?.();
			})
			.catch(() => undefined);
		return pending;
	};
	const timer = setInterval(heartbeat, intervalMs);
	timer.unref?.();

	return {
		lost,
		async stop() {
			clearInterval(timer);
			await pending;
		},
	};
}
