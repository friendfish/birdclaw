import {
	latestDigestCacheKey,
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
 * The same options (period/contentSource/account/includeDms/etc.) always
 * hash to the same key via latestDigestCacheKey, so the registry and the
 * sync_cache row it stores the finished result under share one identity.
 */
export function periodDigestRegistryKey(options: PeriodDigestOptions): string {
	return latestDigestCacheKey(options);
}
