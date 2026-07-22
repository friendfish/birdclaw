import type { Database } from "./sqlite";

export type HomeFeed = "following" | "for_you";

export function upsertTweetFeedEdge(
	db: Database,
	{
		tweetId,
		feed,
		seenAt,
	}: {
		tweetId: string;
		feed: HomeFeed;
		seenAt: string;
	},
) {
	db.prepare(`
    insert into tweet_feed_edges (tweet_id, feed, first_seen_at)
    values (?, ?, ?)
    on conflict(tweet_id, feed) do nothing
  `).run(tweetId, feed, seenAt);
}
