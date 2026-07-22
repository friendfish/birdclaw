import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "#/lib/query-client";
import { fetchQueryEnvelope, postSync } from "#/lib/api-client";
import type { WebSyncKind } from "#/lib/web-sync";

const SYNC_KINDS: WebSyncKind[] = [
	"timeline",
	"mentions",
	"likes",
	"bookmarks",
	"dms",
	"following",
];

export function GlobalBackgroundSync() {
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const accounts = statusQuery.data?.accounts ?? [];
	const syncingRef = useRef<Record<string, boolean>>({});

	useEffect(() => {
		let active = true;

		const runCheck = async () => {
			if (!active || document.visibilityState === "hidden") return;

			// Gather all relevant account suffixes: "default" and actual account IDs
			const suffixes = ["default", ...accounts.map((a) => a.id)];

			for (const kind of SYNC_KINDS) {
				for (const suffix of suffixes) {
					const actualAccountId = suffix === "default" ? undefined : suffix;
					const autoSyncKey = `birdclaw:auto-sync:${kind}:${suffix}`;
					const lastSyncKey = `birdclaw:last-sync-at:${kind}:${suffix}`;

					// 1. Read stored auto-sync configuration
					let enabled = false;
					let intervalMs = 10 * 60_000;
					try {
						const valueRaw = window.localStorage.getItem(autoSyncKey);
						if (valueRaw) {
							const value = JSON.parse(valueRaw);
							enabled = value?.enabled === true;
							if (
								typeof value?.intervalMs === "number" &&
								value.intervalMs > 0
							) {
								intervalMs = value.intervalMs;
							}
						}
					} catch {
						// ignore
					}

					if (!enabled) continue;

					// 2. Read last sync timestamp
					let lastSyncTime = 0;
					const storedLastSync = window.localStorage.getItem(lastSyncKey);
					if (storedLastSync) {
						lastSyncTime = Number(storedLastSync);
					}

					const now = Date.now();
					const nextSyncTime = lastSyncTime ? lastSyncTime + intervalMs : now;

					if (now >= nextSyncTime) {
						const syncKey = `${kind}:${suffix}`;
						if (syncingRef.current[syncKey]) continue;

						syncingRef.current[syncKey] = true;

						// Dispatch start event
						window.dispatchEvent(
							new CustomEvent("birdclaw:auto-sync-started", {
								detail: { kind, accountId: suffix },
							}),
						);

						try {
							const data = await postSync(kind, actualAccountId);
							if (data.ok) {
								const completedTime = Date.now();
								window.localStorage.setItem(lastSyncKey, String(completedTime));

								// Dispatch completed event
								window.dispatchEvent(
									new CustomEvent("birdclaw:auto-sync-completed", {
										detail: {
											kind,
											accountId: suffix,
											timestamp: completedTime,
											summary: data.summary,
										},
									}),
								);
							} else {
								throw new Error(data.summary);
							}
						} catch (err: any) {
							// Dispatch failed event
							window.dispatchEvent(
								new CustomEvent("birdclaw:auto-sync-failed", {
									detail: {
										kind,
										accountId: suffix,
										error: err.message || "Sync failed",
									},
								}),
							);
						} finally {
							syncingRef.current[syncKey] = false;
						}
					}
				}
			}
		};

		// Run check immediately on load and then every 10 seconds
		const timer = window.setInterval(runCheck, 10_000);
		const initialTimer = window.setTimeout(runCheck, 1000);

		return () => {
			active = false;
			window.clearInterval(timer);
			window.clearTimeout(initialTimer);
		};
	}, [accounts]);

	return null;
}
