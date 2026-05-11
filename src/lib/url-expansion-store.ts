import type { Database } from "./sqlite";
import type { LinkIndexItem } from "./types";

export interface UrlExpansionRecordInput {
	url: string;
	expandedUrl: string;
	finalUrl: string;
	status: "hit" | "miss" | "error";
	title?: string;
	description?: string | null;
	error?: string;
	source: string;
	updatedAt: string;
}

function getTweetTarget(url: string) {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		if (
			host !== "x.com" &&
			host !== "twitter.com" &&
			host !== "mobile.twitter.com" &&
			host !== "www.x.com" &&
			host !== "www.twitter.com"
		) {
			return {};
		}

		const parts = parsed.pathname.split("/").filter(Boolean);
		const statusIndex = parts.findIndex(
			(part) => part === "status" || part === "statuses",
		);
		if (statusIndex === -1 || !parts[statusIndex + 1]) {
			return {};
		}

		const tweetId = parts[statusIndex + 1]?.match(/^\d+/)?.[0];
		const handle =
			parts[statusIndex - 1] && parts[statusIndex - 1] !== "i"
				? parts[statusIndex - 1]
				: undefined;
		return {
			expandedTweetId: tweetId,
			expandedHandle: handle,
		};
	} catch {
		return {};
	}
}

export function normalizeUrlExpansionForIndex(
	item: UrlExpansionRecordInput,
): LinkIndexItem {
	const target = getTweetTarget(item.finalUrl);
	return {
		shortUrl: item.url,
		expandedUrl: item.expandedUrl,
		finalUrl: item.finalUrl,
		status: item.status,
		expandedTweetId: target.expandedTweetId ?? null,
		expandedHandle: target.expandedHandle ?? null,
		title: item.title ?? null,
		description: item.description ?? null,
		error: item.error ?? null,
		source: item.source,
		updatedAt: item.updatedAt,
	};
}

export function upsertUrlExpansion(db: Database, item: LinkIndexItem) {
	db.prepare(`
    insert into url_expansions (
      short_url, expanded_url, final_url, status, expanded_tweet_id,
      expanded_handle, title, description, error, source, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(short_url) do update set
      expanded_url = excluded.expanded_url,
      final_url = excluded.final_url,
      status = excluded.status,
      expanded_tweet_id = excluded.expanded_tweet_id,
      expanded_handle = excluded.expanded_handle,
      title = excluded.title,
      description = excluded.description,
      error = excluded.error,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(
		item.shortUrl,
		item.expandedUrl,
		item.finalUrl,
		item.status,
		item.expandedTweetId,
		item.expandedHandle,
		item.title,
		item.description,
		item.error,
		item.source,
		item.updatedAt,
	);
}
