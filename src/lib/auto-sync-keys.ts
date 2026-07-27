import type { WebSyncKind } from "./web-sync";

export const AUTO_SYNC_INTERVALS = [
	{ label: "5m", value: 5 * 60_000 },
	{ label: "10m", value: 10 * 60_000 },
	{ label: "15m", value: 15 * 60_000 },
	{ label: "30m", value: 30 * 60_000 },
	{ label: "1h", value: 60 * 60_000 },
] as const;
export const DEFAULT_AUTO_SYNC_INTERVAL_MS = 10 * 60_000;
export const MAX_AUTO_SYNC_BACKOFF_MS = 60 * 60_000;

export interface StoredAutoSyncSettings {
	enabled: boolean;
	intervalMs: number;
}

// The single source of truth for which sync kinds are scoped per-account.
// Both SyncNowButton and GlobalBackgroundSync must derive the account id
// they pass into the storage-key builders below from this same check —
// otherwise the two sides can silently write/read different keys for the
// same logical setting (dms is the current non-account-aware kind: it only
// ever has one, global auto-sync setting, not one per selected account).
export function isAccountAwareSyncKind(kind: WebSyncKind) {
	return kind !== "dms";
}

export function autoSyncStorageKey(
	kind: WebSyncKind,
	accountId: string | undefined,
	scope: string | undefined,
) {
	const suffix = scope ? `:${scope}` : "";
	return `birdclaw:auto-sync:${kind}:${accountId ?? "default"}${suffix}`;
}

export function lastSyncStorageKey(
	kind: WebSyncKind,
	accountId: string | undefined,
	scope: string | undefined,
) {
	const suffix = scope ? `:${scope}` : "";
	return `birdclaw:last-sync-at:${kind}:${accountId ?? "default"}${suffix}`;
}

export function validAutoSyncInterval(value: unknown): value is number {
	return AUTO_SYNC_INTERVALS.some((option) => option.value === value);
}

export function readAutoSyncSettings(key: string): StoredAutoSyncSettings {
	try {
		const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
			enabled?: unknown;
			intervalMs?: unknown;
		} | null;
		return {
			enabled: value?.enabled === true,
			intervalMs: validAutoSyncInterval(value?.intervalMs)
				? value.intervalMs
				: DEFAULT_AUTO_SYNC_INTERVAL_MS,
		};
	} catch {
		return { enabled: false, intervalMs: DEFAULT_AUTO_SYNC_INTERVAL_MS };
	}
}
