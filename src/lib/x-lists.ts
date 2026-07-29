import { Effect } from "effect";
import {
	getAuthenticatedBirdAccountEffect,
	listOwnedXListsViaBirdEffect,
	listXListMembersViaBirdEffect,
} from "./bird";
import { databaseWriteEffect } from "./database-writer";
import { getNativeDb, getReadDb } from "./db";
import { runEffectPromise, toError, trySync } from "./effect-runtime";
import { resolveLiveSyncMode } from "./live-transport-policy";
import {
	assertLiveAccountMatches,
	createLiveTransportAdapter,
	fetchWithTransportFallbackEffect,
	type LiveTransportAdapter,
	resolveLiveSyncAccount,
} from "./live-sync-engine";
import type { Database } from "./sqlite";
import type {
	XListPage,
	XListRecord,
	XurlFollowUsersResponse,
	XurlMentionUser,
} from "./types";
import { upsertProfileFromXUser } from "./x-profile";
import {
	listOwnedXListsViaXurlEffect,
	listXListMembersViaXurlEffect,
	lookupAuthenticatedOAuth2UserEffect,
} from "./xurl";

export type XListSyncMode = "auto" | "bird" | "xurl";
export type XListMembershipStatus =
	| "not_synced"
	| "partial"
	| "inferred"
	| "complete"
	| "error";

export interface SyncXListsOptions {
	account?: string;
	mode?: XListSyncMode;
	maxLists?: number;
	memberLimit?: number;
	maxMemberPages?: number;
	delayMs?: number;
}

export interface StoredXList {
	accountId: string;
	listId: string;
	name: string;
	description: string;
	ownerProfileId?: string;
	ownerExternalUserId?: string;
	isPrivate: boolean;
	memberCount?: number;
	followerCount?: number;
	source: "bird" | "xurl" | "backup";
	membershipStatus: XListMembershipStatus;
	listsSyncedAt: string;
	membersSyncedAt?: string;
	memberPageCount: number;
	memberResultCount: number;
	rateLimit: Record<string, unknown>;
}

export interface StoredXListMember {
	accountId: string;
	listId: string;
	externalUserId: string;
	current: boolean;
	firstSeenAt: string;
	lastSeenAt: string;
	endedAt?: string;
	profile: {
		id: string;
		handle: string;
		displayName: string;
		bio: string;
		followersCount: number;
		avatarUrl?: string;
	};
}

const DEFAULT_MAX_LISTS = 20;
const DEFAULT_MEMBER_LIMIT = 20;
const DEFAULT_MAX_MEMBER_PAGES = 1;
const DEFAULT_DELAY_MS = 1000;
const MAX_LISTS = 100;
const MAX_MEMBER_LIMIT = 100;
const MAX_MEMBER_PAGES = 100;

function positiveInteger(name: string, value: number, maximum: number) {
	if (!Number.isFinite(value) || value < 1 || value > maximum) {
		throw new Error(`${name} must be between 1 and ${String(maximum)}`);
	}
	return Math.floor(value);
}

function nonNegativeInteger(name: string, value: number) {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return Math.floor(value);
}

function normalizedMode(value: string | undefined): XListSyncMode {
	return resolveLiveSyncMode(value);
}

function metaString(meta: Record<string, unknown> | undefined, key: string) {
	const value = meta?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metaNumber(meta: Record<string, unknown> | undefined, key: string) {
	const value = meta?.[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function parseJsonRecord(value: unknown) {
	if (typeof value !== "string" || value.length === 0) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function fetchOwnedListsEffect({
	source,
	account,
	maxLists,
}: {
	source: "bird" | "xurl";
	account: ReturnType<typeof resolveLiveSyncAccount>;
	maxLists: number;
}): Effect.Effect<XListPage, unknown> {
	if (source === "bird") {
		return Effect.gen(function* () {
			const authenticated = yield* getAuthenticatedBirdAccountEffect();
			yield* trySync(() =>
				assertLiveAccountMatches({
					source: "bird",
					account,
					liveUsername: authenticated.username,
					liveExternalUserId: authenticated.id,
				}),
			);
			return yield* listOwnedXListsViaBirdEffect({ maxResults: maxLists });
		});
	}

	return Effect.gen(function* () {
		const authenticated = yield* lookupAuthenticatedOAuth2UserEffect(
			account.username,
		);
		if (!authenticated) {
			return yield* Effect.fail(
				new Error("xurl did not return an OAuth2 user"),
			);
		}
		const liveUsername = String(authenticated.username ?? "");
		const liveExternalUserId = String(authenticated.id ?? "");
		yield* trySync(() =>
			assertLiveAccountMatches({
				source: "xurl",
				account,
				liveUsername,
				liveExternalUserId,
			}),
		);
		const userId = account.externalUserId ?? liveExternalUserId;
		if (!userId) {
			return yield* Effect.fail(
				new Error("xurl authenticated user is missing an id"),
			);
		}
		return yield* listOwnedXListsViaXurlEffect({
			userId,
			username: account.username,
			maxResults: maxLists,
		});
	});
}

function fetchListMembersEffect({
	source,
	list,
	username,
	memberLimit,
	maxMemberPages,
}: {
	source: "bird" | "xurl";
	list: XListRecord;
	username: string;
	memberLimit: number;
	maxMemberPages: number;
}): Effect.Effect<XurlFollowUsersResponse, unknown> {
	if (source === "bird") {
		return listXListMembersViaBirdEffect({
			listId: list.id,
			maxResults: memberLimit,
			maxPages: maxMemberPages,
		});
	}

	return Effect.gen(function* () {
		const data: XurlMentionUser[] = [];
		const seen = new Set<string>();
		let paginationToken: string | undefined;
		let pageCount = 0;
		do {
			const page = yield* listXListMembersViaXurlEffect({
				listId: list.id,
				username,
				maxResults: memberLimit,
				paginationToken,
			});
			pageCount += 1;
			for (const user of page.data) {
				if (seen.has(user.id)) continue;
				seen.add(user.id);
				data.push(user);
			}
			paginationToken = metaString(page.meta, "next_token");
		} while (paginationToken && pageCount < maxMemberPages);

		return {
			data,
			meta: {
				result_count: data.length,
				page_count: pageCount,
				next_token: paginationToken ?? null,
				pagination_known_complete: !paginationToken,
			},
		} satisfies XurlFollowUsersResponse;
	});
}

function membershipStatus({
	list,
	payload,
}: {
	list: XListRecord;
	payload: XurlFollowUsersResponse;
}) {
	if (payload.meta?.pagination_known_complete === true) return "complete";
	if (payload.meta?.pagination_inferred_complete === true) return "inferred";
	if (
		typeof list.memberCount === "number" &&
		payload.data.length >= list.memberCount
	) {
		return "inferred";
	}
	return "partial";
}

function ownerProfileId(db: Database, list: XListRecord) {
	if (!list.ownerId || !list.ownerUsername) return undefined;
	return upsertProfileFromXUser(db, {
		id: list.ownerId,
		username: list.ownerUsername,
		name: list.ownerName ?? list.ownerUsername,
	}).profile.id;
}

function persistListResult({
	db,
	accountId,
	list,
	source,
	payload,
	status,
	now,
	rateLimit,
}: {
	db: Database;
	accountId: string;
	list: XListRecord;
	source: "bird" | "xurl";
	payload?: XurlFollowUsersResponse;
	status: XListMembershipStatus;
	now: string;
	rateLimit: Record<string, unknown>;
}) {
	return db.transaction(() => {
		const listOwnerProfileId = ownerProfileId(db, list);
		const membersSyncedAt = payload ? now : null;
		const pageCount = payload
			? (metaNumber(payload.meta, "page_count") ?? 1)
			: 0;
		const resultCount = payload?.data.length ?? 0;
		db.prepare(
			`
      insert into x_lists (
        account_id, list_id, name, description, owner_profile_id,
        owner_external_user_id, is_private, member_count, follower_count,
        source, membership_status, lists_synced_at, members_synced_at,
        member_page_count, member_result_count, rate_limit_json, raw_json,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(account_id, list_id) do update set
        name = excluded.name,
        description = excluded.description,
        owner_profile_id = coalesce(excluded.owner_profile_id, x_lists.owner_profile_id),
        owner_external_user_id = coalesce(excluded.owner_external_user_id, x_lists.owner_external_user_id),
        is_private = excluded.is_private,
        member_count = coalesce(excluded.member_count, x_lists.member_count),
        follower_count = coalesce(excluded.follower_count, x_lists.follower_count),
        source = excluded.source,
        membership_status = excluded.membership_status,
        lists_synced_at = excluded.lists_synced_at,
        members_synced_at = coalesce(excluded.members_synced_at, x_lists.members_synced_at),
        member_page_count = excluded.member_page_count,
        member_result_count = excluded.member_result_count,
        rate_limit_json = excluded.rate_limit_json,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
      `,
		).run(
			accountId,
			list.id,
			list.name,
			list.description ?? "",
			listOwnerProfileId ?? null,
			list.ownerId ?? null,
			list.isPrivate ? 1 : 0,
			list.memberCount ?? null,
			list.followerCount ?? null,
			source,
			status,
			now,
			membersSyncedAt,
			pageCount,
			resultCount,
			JSON.stringify(rateLimit),
			JSON.stringify(list.raw ?? {}),
			now,
		);

		if (!payload) return;
		if (status === "complete") {
			db.prepare(
				`
        update x_list_members
        set current = 0, ended_at = ?, updated_at = ?
        where account_id = ? and list_id = ? and current = 1
        `,
			).run(now, now, accountId, list.id);
		}

		const upsertMember = db.prepare(`
      insert into x_list_members (
        account_id, list_id, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, 1, ?, ?, null, ?, ?)
      on conflict(account_id, list_id, profile_id) do update set
        external_user_id = excluded.external_user_id,
        source = excluded.source,
        current = 1,
        last_seen_at = excluded.last_seen_at,
        ended_at = null,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);
		for (const user of payload.data) {
			const resolved = upsertProfileFromXUser(db, user);
			upsertMember.run(
				accountId,
				list.id,
				resolved.profile.id,
				resolved.externalUserId,
				source,
				now,
				now,
				JSON.stringify(user),
				now,
			);
		}
	})();
}

export function syncXListsEffect(options: SyncXListsOptions = {}) {
	return Effect.suspend(() => {
		const mode = normalizedMode(options.mode);
		const maxLists = positiveInteger(
			"--max-lists",
			options.maxLists ?? DEFAULT_MAX_LISTS,
			MAX_LISTS,
		);
		const memberLimit = positiveInteger(
			"--member-limit",
			options.memberLimit ?? DEFAULT_MEMBER_LIMIT,
			MAX_MEMBER_LIMIT,
		);
		const maxMemberPages = positiveInteger(
			"--max-member-pages",
			options.maxMemberPages ?? DEFAULT_MAX_MEMBER_PAGES,
			MAX_MEMBER_PAGES,
		);
		const delayMs = nonNegativeInteger(
			"--delay-ms",
			options.delayMs ?? DEFAULT_DELAY_MS,
		);
		const db = getNativeDb();
		const account = resolveLiveSyncAccount(db, options.account);
		const sources =
			mode === "auto"
				? (["bird", "xurl"] as const)
				: ([mode] as readonly ("bird" | "xurl")[]);
		const transports: Array<LiveTransportAdapter<"bird" | "xurl", XListPage>> =
			sources.map((source) =>
				createLiveTransportAdapter(
					source,
					fetchOwnedListsEffect({ source, account, maxLists }),
				),
			);

		return Effect.gen(function* () {
			const discovered = yield* fetchWithTransportFallbackEffect(transports);
			const source = discovered.source;
			const lists = discovered.payload.data.slice(0, maxLists);
			const results: Array<Record<string, unknown>> = [];

			for (const [index, list] of lists.entries()) {
				if (index > 0 && delayMs > 0) yield* Effect.sleep(delayMs);
				const fetched = yield* fetchListMembersEffect({
					source,
					list,
					username: account.username,
					memberLimit,
					maxMemberPages,
				}).pipe(
					Effect.map((payload) => ({ ok: true as const, payload })),
					Effect.catchAll((error) =>
						Effect.succeed({ ok: false as const, error: toError(error) }),
					),
				);
				const now = new Date().toISOString();
				const rateLimit = {
					memberLimit,
					maxMemberPages,
					delayMs,
					nextCursorStored: fetched.ok
						? Boolean(metaString(fetched.payload.meta, "next_token"))
						: false,
				};

				if (!fetched.ok) {
					yield* databaseWriteEffect((writeDb) =>
						persistListResult({
							db: writeDb,
							accountId: account.accountId,
							list,
							source,
							status: "error",
							now,
							rateLimit,
						}),
					);
					results.push({
						listId: list.id,
						name: list.name,
						status: "error",
						error: fetched.error.message,
					});
					continue;
				}

				const status = membershipStatus({ list, payload: fetched.payload });
				yield* databaseWriteEffect((writeDb) =>
					persistListResult({
						db: writeDb,
						accountId: account.accountId,
						list,
						source,
						payload: fetched.payload,
						status,
						now,
						rateLimit,
					}),
				);
				results.push({
					listId: list.id,
					name: list.name,
					status,
					members: fetched.payload.data.length,
					pages: metaNumber(fetched.payload.meta, "page_count") ?? 1,
				});
			}

			const errors = results.filter((result) => result.status === "error");
			return {
				ok: errors.length === 0,
				accountId: account.accountId,
				mode,
				source,
				listCount: lists.length,
				membershipCompleteCount: results.filter(
					(result) => result.status === "complete",
				).length,
				membershipPartialCount: results.filter(
					(result) => result.status === "partial",
				).length,
				membershipInferredCount: results.filter(
					(result) => result.status === "inferred",
				).length,
				errorCount: errors.length,
				rateLimit: { maxLists, memberLimit, maxMemberPages, delayMs },
				lists: results,
			};
		});
	});
}

export function syncXLists(options: SyncXListsOptions = {}) {
	return runEffectPromise(syncXListsEffect(options));
}

function accountIdForRead(db: Database, account?: string) {
	return resolveLiveSyncAccount(db, account).accountId;
}

function storedListFromRow(row: Record<string, unknown>): StoredXList {
	return {
		accountId: String(row.account_id),
		listId: String(row.list_id),
		name: String(row.name),
		description: String(row.description ?? ""),
		...(row.owner_profile_id
			? { ownerProfileId: String(row.owner_profile_id) }
			: {}),
		...(row.owner_external_user_id
			? { ownerExternalUserId: String(row.owner_external_user_id) }
			: {}),
		isPrivate: Number(row.is_private) === 1,
		...(typeof row.member_count === "number"
			? { memberCount: row.member_count }
			: {}),
		...(typeof row.follower_count === "number"
			? { followerCount: row.follower_count }
			: {}),
		source: String(row.source) as StoredXList["source"],
		membershipStatus: String(row.membership_status) as XListMembershipStatus,
		listsSyncedAt: String(row.lists_synced_at),
		...(row.members_synced_at
			? { membersSyncedAt: String(row.members_synced_at) }
			: {}),
		memberPageCount: Number(row.member_page_count),
		memberResultCount: Number(row.member_result_count),
		rateLimit: parseJsonRecord(row.rate_limit_json),
	};
}

export function listStoredXLists(options: { account?: string } = {}) {
	const db = getReadDb();
	const accountId = accountIdForRead(db, options.account);
	return (
		db
			.prepare(
				`select * from x_lists where account_id = ? order by name collate nocase, list_id`,
			)
			.all(accountId) as Array<Record<string, unknown>>
	).map(storedListFromRow);
}

export function resolveStoredXListSelector({
	account,
	listId,
	name,
}: {
	account?: string;
	listId?: string;
	name?: string;
}) {
	if (Boolean(listId) === Boolean(name)) {
		throw new Error("Choose exactly one of --list or --list-id");
	}
	const db = getReadDb();
	const accountId = accountIdForRead(db, account);
	const rows = listId
		? (db
				.prepare("select * from x_lists where account_id = ? and list_id = ?")
				.all(accountId, listId) as Array<Record<string, unknown>>)
		: (db
				.prepare(
					"select * from x_lists where account_id = ? and name = ? collate nocase order by list_id",
				)
				.all(accountId, name) as Array<Record<string, unknown>>);
	if (rows.length === 0) {
		throw new Error(
			`No cached List matches ${listId ? `id ${listId}` : `name ${name}`}; run birdclaw sync lists`,
		);
	}
	if (rows.length > 1) {
		throw new Error(
			`List name ${name} is ambiguous; use --list-id (${rows.map((row) => String(row.list_id)).join(", ")})`,
		);
	}
	return storedListFromRow(rows[0] as Record<string, unknown>);
}

export function listStoredXListMembers({
	account,
	listId,
	name,
	includeEnded = false,
	limit = 100,
}: {
	account?: string;
	listId?: string;
	name?: string;
	includeEnded?: boolean;
	limit?: number;
}) {
	const list = resolveStoredXListSelector({ account, listId, name });
	const db = getReadDb();
	const rows = db
		.prepare(
			`
      select
        member.account_id, member.list_id, member.external_user_id,
        member.current, member.first_seen_at, member.last_seen_at,
        member.ended_at, profile.id as profile_id, profile.handle,
        profile.display_name, profile.bio, profile.followers_count,
        profile.avatar_url
      from x_list_members member
      join profiles profile on profile.id = member.profile_id
      where member.account_id = ? and member.list_id = ?
        and (? = 1 or member.current = 1)
      order by profile.followers_count desc, profile.handle collate nocase
      limit ?
      `,
		)
		.all(
			list.accountId,
			list.listId,
			includeEnded ? 1 : 0,
			positiveInteger("--limit", limit, 10_000),
		) as Array<Record<string, unknown>>;
	const items: StoredXListMember[] = rows.map((row) => ({
		accountId: String(row.account_id),
		listId: String(row.list_id),
		externalUserId: String(row.external_user_id),
		current: Number(row.current) === 1,
		firstSeenAt: String(row.first_seen_at),
		lastSeenAt: String(row.last_seen_at),
		...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
		profile: {
			id: String(row.profile_id),
			handle: String(row.handle),
			displayName: String(row.display_name),
			bio: String(row.bio),
			followersCount: Number(row.followers_count),
			...(row.avatar_url ? { avatarUrl: String(row.avatar_url) } : {}),
		},
	}));
	return { list, items };
}
