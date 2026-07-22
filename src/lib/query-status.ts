import { Effect } from "effect";
import type { QueryEnvelope } from "./api-contracts";
import type { Database } from "./sqlite";
import { findArchivesCachedEffect } from "./archive-finder";
import { getReadDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import type { AccountRecord } from "./types";
import { getTransportStatusEffect } from "./xurl";

export type { QueryEnvelope } from "./api-contracts";

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({ try: try_, catch: toError });
}

function countTimelineEdges(db: Database, kind: "home" | "mention") {
	const row = db
		.prepare(
			`
      select count(distinct tweet_id) as count
		from tweet_account_edges edge
		where edge.kind = ?
		  and exists (
			select 1 from tweets t
			where t.id = edge.tweet_id
			  and t.deleted_at is null
			  and t.superseded_at is null
		  )
      `,
		)
		.get(kind) as { count: number | bigint } | undefined;
	return Number(row?.count ?? 0);
}

function countFeedEdges(db: Database, feed: "following" | "for_you") {
	// Scoped to actual home-timeline membership, not just any tweet that ever
	// carries this feed tag: historical feed_types data predates the
	// tweet_feed_edges migration and was backfilled across every tweet row
	// (mentions, authored, archive-imported, ...), not only home-timeline ones.
	const row = db
		.prepare(
			`
      select count(distinct edge.tweet_id) as count
		from tweet_feed_edges edge
		where edge.feed = ?
		  and exists (
			select 1 from tweet_account_edges home_edge
			where home_edge.tweet_id = edge.tweet_id
			  and home_edge.kind = 'home'
		  )
		  and exists (
			select 1 from tweets t
			where t.id = edge.tweet_id
			  and t.deleted_at is null
			  and t.superseded_at is null
		  )
      `,
		)
		.get(feed) as { count: number | bigint } | undefined;
	return Number(row?.count ?? 0);
}

function getAccountProfileMeta(
	db: Database,
	account: { handle: string; external_user_id: string | null },
) {
	const handle = account.handle.replace(/^@/, "");
	const externalProfileId = account.external_user_id
		? `profile_user_${account.external_user_id}`
		: "";
	return db
		.prepare(
			`
      select id, avatar_hue, avatar_url
      from profiles
      where id = ?
         or lower(handle) = lower(?)
      order by case
        when id = 'profile_me' then 0
        when id = ? then 1
        else 2
      end
      limit 1
    `,
		)
		.get(externalProfileId, handle, externalProfileId) as
		| { id: string; avatar_hue: number; avatar_url: string | null }
		| undefined;
}

export function getQueryEnvelopeEffect({
	includeArchives = true,
}: { includeArchives?: boolean } = {}): Effect.Effect<QueryEnvelope, unknown> {
	return Effect.gen(function* () {
		const nativeDb = yield* trySync(() => getReadDb());
		const homeCount = yield* trySync(() =>
			countTimelineEdges(nativeDb, "home"),
		);
		const mentionCount = yield* trySync(() =>
			countTimelineEdges(nativeDb, "mention"),
		);
		const homeForYouCount = yield* trySync(() =>
			countFeedEdges(nativeDb, "for_you"),
		);
		const homeFollowingCount = yield* trySync(() =>
			countFeedEdges(nativeDb, "following"),
		);
		const counts = yield* Effect.all({
			dms: trySync(
				() =>
					nativeDb
						.prepare("select count(*) as count from dm_conversations")
						.get() as { count: number },
			),
			needsReply: trySync(
				() =>
					nativeDb
						.prepare(
							"select count(*) as count from dm_conversations where needs_reply = 1",
						)
						.get() as { count: number },
			),
			accounts: trySync(
				() =>
					nativeDb
						.prepare(
							"select * from accounts order by is_default desc, name asc",
						)
						.all() as Array<{
						id: string;
						name: string;
						handle: string;
						external_user_id: string | null;
						transport: string;
						is_default: number;
						created_at: string;
					}>,
			),
			archives: includeArchives
				? findArchivesCachedEffect()
				: Effect.succeed([]),
			transport: getTransportStatusEffect(),
		});

		return {
			stats: {
				home: homeCount,
				homeForYou: homeForYouCount,
				homeFollowing: homeFollowingCount,
				mentions: mentionCount,
				dms: Number(counts.dms.count),
				needsReply: Number(counts.needsReply.count),
				inbox: mentionCount + Number(counts.needsReply.count),
			},
			accounts: counts.accounts.map((row) => {
				const profile = getAccountProfileMeta(nativeDb, row);
				return {
					id: row.id,
					name: row.name,
					handle: row.handle,
					externalUserId: row.external_user_id,
					...(profile
						? {
								profileId: profile.id,
								avatarHue: Number(profile.avatar_hue),
								...(profile.avatar_url
									? { avatarUrl: profile.avatar_url }
									: {}),
							}
						: {}),
					transport: row.transport,
					isDefault: row.is_default,
					createdAt: row.created_at,
				};
			}) satisfies AccountRecord[],
			archives: counts.archives,
			transport: counts.transport,
		};
	});
}

export function getQueryEnvelope(
	options: { includeArchives?: boolean } = {},
): Promise<QueryEnvelope> {
	return runEffectPromise(getQueryEnvelopeEffect(options));
}
