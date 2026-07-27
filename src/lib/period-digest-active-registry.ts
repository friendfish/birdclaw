import {
	periodDigestGenerationKey,
	type PeriodDigestOptions,
} from "./period-digest";

export interface ActivePeriodDigestStatus {
	label: string;
	detail?: string;
}

type Registry = Map<string, ActivePeriodDigestStatus>;

interface GlobalWithRegistry {
	__birdclawActivePeriodDigests?: Registry;
}

/**
 * Module-scoped state wouldn't survive Vite dev-server HMR reloading this
 * route's dependency graph mid-generation, so this lives on globalThis —
 * same trick /api/profile-analysis-metadata uses for its registry.
 */
export function activePeriodDigestsRegistry(): Registry {
	const holder = globalThis as GlobalWithRegistry;
	holder.__birdclawActivePeriodDigests ??= new Map();
	return holder.__birdclawActivePeriodDigests;
}

/**
 * Deliberately independent of AI model/language/reasoningEffort/serviceTier
 * (see periodDigestGenerationKey) — this key identifies "a generation for
 * this content", not "a result produced with this exact config", so
 * changing the AI model mid-generation doesn't make an in-progress run
 * invisible to a later poll.
 */
export function periodDigestRegistryKey(options: PeriodDigestOptions): string {
	return periodDigestGenerationKey(options);
}
