import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	autoSyncStorageKey,
	lastSyncStorageKey,
	MAX_AUTO_SYNC_BACKOFF_MS,
	readAutoSyncSettings,
} from "#/lib/auto-sync-keys";
import { fetchQueryEnvelope, postSync } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type { WebSyncKind, WebSyncResponse } from "#/lib/web-sync";
import { defaultAccountId } from "./account-selection";

const SYNC_KINDS: WebSyncKind[] = [
	"timeline",
	"mentions",
	"likes",
	"bookmarks",
	"dms",
	"following",
];

// Home's For You/Following tabs run independent auto-sync schedules under one
// kind ("timeline"); every other kind is unscoped (scope === undefined).
const KIND_SCOPES: Partial<Record<WebSyncKind, readonly string[]>> = {
	timeline: ["following", "for_you"],
};

export interface AutoSyncEventDetail {
	kind: WebSyncKind;
	accountId: string;
	scope: string | undefined;
}

export interface AutoSyncCompletedDetail extends AutoSyncEventDetail {
	timestamp: number;
	summary: string;
	result: WebSyncResponse;
}

export interface AutoSyncFailedDetail extends AutoSyncEventDetail {
	error: string;
}

export function GlobalBackgroundSync() {
	const queryClient = useQueryClient();
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const accounts = statusQuery.data?.accounts ?? [];
	const syncingRef = useRef<Record<string, boolean>>({});
	const failureCountRef = useRef<Record<string, number>>({});
	// Backoff is measured from the last *attempt* (success or failure), not
	// just the last success recorded in localStorage — otherwise a failed
	// sync (which never writes lastSyncKey) would look "never synced" and
	// get retried on every poll tick instead of backing off.
	const lastAttemptRef = useRef<Record<string, number>>({});

	useEffect(() => {
		let active = true;
		const accountDefaultId = defaultAccountId(accounts);

		const runCheck = async () => {
			if (!active || document.visibilityState === "hidden") return;

			const suffixes = ["default", ...accounts.map((a) => a.id)];

			for (const kind of SYNC_KINDS) {
				// dms is not account-aware: only ever synced once, under "default".
				const kindSuffixes = kind === "dms" ? ["default"] : suffixes;
				for (const scope of KIND_SCOPES[kind] ?? [undefined]) {
					for (const suffix of kindSuffixes) {
						const actualAccountId = suffix === "default" ? undefined : suffix;

						// For You can only ever be synced for the default account (bird
						// authenticates a single session; xurl can't fetch it at all).
						if (
							kind === "timeline" &&
							scope === "for_you" &&
							actualAccountId !== undefined &&
							actualAccountId !== accountDefaultId
						) {
							continue;
						}

						const autoSyncKey = autoSyncStorageKey(
							kind,
							actualAccountId,
							scope,
						);
						const lastSyncKey = lastSyncStorageKey(
							kind,
							actualAccountId,
							scope,
						);
						const { enabled, intervalMs } = readAutoSyncSettings(autoSyncKey);
						if (!enabled) continue;

						const syncKey = `${kind}:${suffix}:${scope ?? ""}`;
						const storedLastSync = window.localStorage.getItem(lastSyncKey);
						const lastSyncTime = storedLastSync ? Number(storedLastSync) : 0;
						const failureCount = failureCountRef.current[syncKey] ?? 0;
						const lastAttemptTime =
							lastAttemptRef.current[syncKey] ?? lastSyncTime;
						const backoffMs = Math.min(
							intervalMs * 2 ** failureCount,
							MAX_AUTO_SYNC_BACKOFF_MS,
						);
						const nextSyncTime = lastAttemptTime
							? lastAttemptTime + backoffMs
							: Date.now();

						if (Date.now() < nextSyncTime) continue;
						if (syncingRef.current[syncKey]) continue;

						syncingRef.current[syncKey] = true;
						window.dispatchEvent(
							new CustomEvent<AutoSyncEventDetail>(
								"birdclaw:auto-sync-started",
								{ detail: { kind, accountId: suffix, scope } },
							),
						);

						try {
							const data = await postSync(
								kind,
								actualAccountId,
								scope && kind === "timeline"
									? { feed: scope as "following" | "for_you" }
									: {},
							);
							if (!data.ok) throw new Error(data.summary);
							const completedTime = Date.now();
							window.localStorage.setItem(lastSyncKey, String(completedTime));
							failureCountRef.current[syncKey] = 0;
							lastAttemptRef.current[syncKey] = completedTime;
							// A view observing this sync's data may not be mounted right
							// now (e.g. the user navigated away from Home before this
							// fired), so SyncNowButton's onSynced callback alone can't be
							// relied on to refresh it — invalidate the shared caches
							// directly so the data is fresh whenever the user comes back.
							void queryClient.invalidateQueries({
								queryKey: queryKeys.status,
							});
							void queryClient.invalidateQueries({
								queryKey: kind === "dms" ? queryKeys.dms : queryKeys.timelines,
							});
							window.dispatchEvent(
								new CustomEvent<AutoSyncCompletedDetail>(
									"birdclaw:auto-sync-completed",
									{
										detail: {
											kind,
											accountId: suffix,
											scope,
											timestamp: completedTime,
											summary: data.summary,
											result: data,
										},
									},
								),
							);
						} catch (err) {
							failureCountRef.current[syncKey] = failureCount + 1;
							lastAttemptRef.current[syncKey] = Date.now();
							window.dispatchEvent(
								new CustomEvent<AutoSyncFailedDetail>(
									"birdclaw:auto-sync-failed",
									{
										detail: {
											kind,
											accountId: suffix,
											scope,
											error: err instanceof Error ? err.message : "Sync failed",
										},
									},
								),
							);
						} finally {
							syncingRef.current[syncKey] = false;
						}
					}
				}
			}
		};

		const timer = window.setInterval(runCheck, 10_000);
		const initialTimer = window.setTimeout(runCheck, 1000);

		return () => {
			active = false;
			window.clearInterval(timer);
			window.clearTimeout(initialTimer);
		};
	}, [accounts, queryClient]);

	return null;
}
