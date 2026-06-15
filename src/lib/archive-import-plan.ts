export type ArchiveTweetRow = {
	id: string;
	kind: "home" | "like" | "bookmark";
	authorProfileId: string;
	text: string;
	createdAt: string;
	isReplied: number;
	replyToId: string | null;
	likeCount: number;
	mediaCount: number;
	bookmarked: number;
	liked: number;
	entitiesJson: string;
	mediaJson: string;
	quotedTweetId: string | null;
};

export type ArchiveCollectionRow = {
	tweetId: string;
	kind: "likes" | "bookmarks";
	collectedAt: string | null;
	source: string;
	rawJson: string;
};

export type ArchiveProfileRow = {
	id: string;
	handle: string;
	displayName: string;
	bio: string;
	followersCount: number;
	followingCount: number;
	publicMetricsJson: string;
	avatarHue: number;
	avatarUrl: string | null;
	location: string | null;
	url: string | null;
	verifiedType: string | null;
	entitiesJson: string;
	rawJson: string;
	createdAt: string;
};

export type ArchiveConversationRow = {
	id: string;
	title: string;
	accountId: string;
	participantProfileId: string;
	lastMessageAt: string;
	unreadCount: number;
	needsReply: number;
};

export type ArchiveMessageRow = {
	id: string;
	conversationId: string;
	senderProfileId: string;
	text: string;
	createdAt: string;
	direction: "inbound" | "outbound";
	mediaCount: number;
};

export type ArchiveFollowRow = {
	profileId: string;
	externalUserId: string;
};

export class ArchiveImportPlan {
	readonly mentionDirectory = new Map<
		string,
		{ handle?: string; displayName?: string }
	>();
	readonly tweets: ArchiveTweetRow[] = [];
	readonly collections: ArchiveCollectionRow[] = [];
	readonly profiles = new Map<string, ArchiveProfileRow>();
	readonly conversations = new Map<string, ArchiveConversationRow>();
	readonly dmMessages: ArchiveMessageRow[] = [];
	readonly followers: ArchiveFollowRow[] = [];
	readonly following: ArchiveFollowRow[] = [];
	readonly followerIds = new Set<string>();
	readonly followingIds = new Set<string>();

	private readonly tweetsById = new Map<string, ArchiveTweetRow>();

	addTweet(row: ArchiveTweetRow) {
		const existing = this.tweetsById.get(row.id);
		if (existing) {
			existing.bookmarked = Math.max(existing.bookmarked, row.bookmarked);
			existing.liked = Math.max(existing.liked, row.liked);
			if (!existing.text && row.text) existing.text = row.text;
			return existing;
		}
		this.tweets.push(row);
		this.tweetsById.set(row.id, row);
		return row;
	}

	getTweet(id: string) {
		return this.tweetsById.get(id);
	}
}
