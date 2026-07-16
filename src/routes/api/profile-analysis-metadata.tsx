import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { getNativeDb } from "#/lib/db";
import { jsonResponse, runRouteEffect, sensitiveRequestErrorResponse } from "#/lib/http-effect";

export const Route = createFileRoute("/api/profile-analysis-metadata")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const handle = url.searchParams.get("handle");

						const db = getNativeDb();

						if (handle) {
							// Return snapshots for this handle
							const cleanTargetHandle = handle.toLowerCase().replace(/^@/, "");
							const results = db.prepare(`
								select cache_key as cacheKey, value_json as valueJson, updated_at as updatedAt
								from sync_cache
								where cache_key like 'profile-analysis:result:%'
								order by updated_at desc
							`).all() as Array<{ cacheKey: string; valueJson: string; updatedAt: string }>;

							const snapshots = [];
							for (const row of results) {
								try {
									const data = JSON.parse(row.valueJson);
									const targetHandle = data?.context?.handle || "";
									const cleanTarget = targetHandle.toLowerCase().replace(/^@/, "");
									const match = cleanTarget === cleanTargetHandle;
									if (match) {
										snapshots.push({
											cacheKey: row.cacheKey,
											updatedAt: row.updatedAt,
											model: data.model || "unknown",
											title: data?.analysis?.title || "Profile Analysis",
											summary: data?.analysis?.summary || "",
											markdown: data.markdown || ""
										});
									}
								} catch {
									// ignore
								}
							}

							return jsonResponse({
								ok: true,
								snapshots,
							});
						} else {
							// Return following list and analyzed list
							// Filter out deleted/stub accounts with no display name or id-based handles
							const followingRows = db.prepare(`
								select p.id, p.handle, p.display_name as displayName, p.bio, p.avatar_url as avatarUrl, p.avatar_hue as avatarHue
								from follow_edges fe
								join profiles p on p.id = fe.profile_id
								where fe.direction = 'following'
								  and fe.current = 1
								  and p.display_name != ''
								  and p.handle not glob 'id[0-9]*'
								order by p.display_name collate nocase asc
							`).all() as Array<{ id: string; handle: string; displayName: string; bio: string; avatarUrl: string | null; avatarHue: number }>;

							const contextRows = db.prepare(`
								select cache_key as cacheKey, updated_at as updatedAt from sync_cache
								where cache_key like 'profile-analysis:context:%'
								order by updated_at desc
							`).all() as Array<{ cacheKey: string; updatedAt: string }>;

							const analyzedMap = new Map<string, string>();
							for (const row of contextRows) {
								const parts = row.cacheKey.split(":");
								if (parts.length >= 4) {
									const h = parts[3].toLowerCase();
									if (!analyzedMap.has(h)) {
										analyzedMap.set(h, row.updatedAt);
									}
								}
							}

							const handles = [...analyzedMap.keys()];
							let analyzedList: any[] = [];
							if (handles.length > 0) {
								const placeholders = handles.map(() => "?").join(",");
								const profiles = db.prepare(`
									select id, handle, display_name as displayName, bio, avatar_url as avatarUrl, avatar_hue as avatarHue
									from profiles
									where lower(handle) in (${placeholders})
									  and display_name != ''
									  and handle not glob 'id[0-9]*'
								`).all(...handles) as Array<{ id: string; handle: string; displayName: string; bio: string; avatarUrl: string | null; avatarHue: number }>;

								analyzedList = profiles.map(p => ({
									...p,
									lastAnalyzedAt: analyzedMap.get(p.handle.toLowerCase())
								})).sort((a, b) => (b.lastAnalyzedAt || "").localeCompare(a.lastAnalyzedAt || ""));
							}

							return jsonResponse({
								ok: true,
								following: followingRows,
								analyzed: analyzedList,
							});
						}
					}),
				),
		},
	},
});
