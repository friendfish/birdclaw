import { expandUrlsFromTexts } from "./url-expansion";
import { resolveProfilesForIds } from "./profile-resolver";
import { listDmConversations, listTimelineItems } from "./queries";
import type {
	DmConversationItem,
	ProfileAffiliation,
	ProfileRecord,
	TimelineItem,
	UrlExpansionItem,
} from "./types";

export interface WhoisOptions {
	account?: string;
	dms?: boolean;
	tweets?: boolean;
	resolveProfiles?: boolean;
	expandUrls?: boolean;
	refreshProfileCache?: boolean;
	refreshUrlCache?: boolean;
	xurlFallback?: boolean;
	context?: number;
	limit?: number;
}

export interface WhoisCandidate {
	conversation: DmConversationItem;
	confidence: number;
	reasons: string[];
	profileEvidence: WhoisEvidenceSignal[];
	evidence: Array<{
		messageId: string;
		createdAt: string;
		direction: string;
		text: string;
		urlExpansions?: UrlExpansionItem[];
	}>;
}

export interface WhoisResult {
	query: string;
	candidates: WhoisCandidate[];
	relatedTweets: TimelineItem[];
	urlExpansions: UrlExpansionItem[];
	profileResolution?: Awaited<ReturnType<typeof resolveProfilesForIds>>;
}

export interface WhoisEvidenceSignal {
	kind:
		| "profile_handle"
		| "profile_name"
		| "profile_bio"
		| "profile_location"
		| "profile_url"
		| "profile_bio_url"
		| "profile_verified_type"
		| "affiliation"
		| "dm_context"
		| "expanded_url";
	value: string;
	source: "profile" | "affiliation" | "dm" | "url";
}

function normalizeQuery(query: string) {
	return query.trim().toLowerCase();
}

function getMessageTexts(conversation: DmConversationItem) {
	return (conversation.matches ?? []).flatMap((match) => [
		...match.before.map((message) => message.text),
		match.message.text,
		...match.after.map((message) => message.text),
	]);
}

function getUrlEntityExpandedUrl(entity: unknown) {
	if (!entity || typeof entity !== "object") {
		return undefined;
	}
	const record = entity as Record<string, unknown>;
	const expanded = record.expandedUrl ?? record.expanded_url ?? record.url;
	return typeof expanded === "string" && expanded.length > 0
		? expanded
		: undefined;
}

function getProfileBioUrls(profile: ProfileRecord) {
	const description = profile.entities?.description;
	if (!description || typeof description !== "object") {
		return [];
	}
	const urls = (description as { urls?: unknown }).urls;
	if (!Array.isArray(urls)) {
		return [];
	}
	return urls
		.map(getUrlEntityExpandedUrl)
		.filter((url): url is string => Boolean(url));
}

function getAffiliationTexts(affiliation: ProfileAffiliation) {
	return [
		affiliation.organizationName,
		affiliation.organizationHandle,
		affiliation.label,
		affiliation.url,
		affiliation.organizationProfileId,
	].filter((item): item is string => Boolean(item));
}

function pushMatchEvidence(
	signals: WhoisEvidenceSignal[],
	query: string,
	kind: WhoisEvidenceSignal["kind"],
	value: string | undefined | null,
	source: WhoisEvidenceSignal["source"],
) {
	if (!value || !value.toLowerCase().includes(query)) {
		return;
	}
	signals.push({ kind, value, source });
}

function collectProfileEvidence(query: string, profile: ProfileRecord) {
	const signals: WhoisEvidenceSignal[] = [];
	pushMatchEvidence(
		signals,
		query,
		"profile_handle",
		profile.handle,
		"profile",
	);
	pushMatchEvidence(
		signals,
		query,
		"profile_name",
		profile.displayName,
		"profile",
	);
	pushMatchEvidence(signals, query, "profile_bio", profile.bio, "profile");
	pushMatchEvidence(
		signals,
		query,
		"profile_location",
		profile.location,
		"profile",
	);
	pushMatchEvidence(signals, query, "profile_url", profile.url, "profile");
	pushMatchEvidence(
		signals,
		query,
		"profile_verified_type",
		profile.verifiedType,
		"profile",
	);
	for (const url of getProfileBioUrls(profile)) {
		pushMatchEvidence(signals, query, "profile_bio_url", url, "profile");
	}
	for (const affiliation of profile.affiliations ?? []) {
		for (const text of getAffiliationTexts(affiliation)) {
			pushMatchEvidence(signals, query, "affiliation", text, "affiliation");
		}
	}
	return signals;
}

function scoreCandidate(
	query: string,
	conversation: DmConversationItem,
	expansions: UrlExpansionItem[],
) {
	const normalized = normalizeQuery(query);
	const profile = conversation.participant;
	const profileEvidence = collectProfileEvidence(normalized, profile);
	const affiliationTexts = (profile.affiliations ?? []).flatMap(
		getAffiliationTexts,
	);
	const profileBioUrls = getProfileBioUrls(profile);
	const haystack = [
		conversation.title,
		profile.handle,
		profile.displayName,
		profile.bio,
		profile.location,
		profile.url,
		profile.verifiedType,
		...profileBioUrls,
		...affiliationTexts,
		...getMessageTexts(conversation),
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	const reasons: string[] = [];
	let confidence = 20;

	if (!/^id\d+$/.test(conversation.participant.handle)) {
		confidence += 25;
		reasons.push("resolved profile");
	}
	if (
		profile.handle.toLowerCase().includes(normalized) ||
		profile.displayName.toLowerCase().includes(normalized) ||
		profile.bio.toLowerCase().includes(normalized)
	) {
		confidence += 20;
		reasons.push("profile matches query");
	}
	if (
		profile.url?.toLowerCase().includes(normalized) ||
		profileBioUrls.some((url) => url.toLowerCase().includes(normalized))
	) {
		confidence += 20;
		reasons.push("profile URL matches query");
	}
	if (profileEvidence.some((signal) => signal.kind === "affiliation")) {
		confidence += 30;
		reasons.push("affiliation matches query");
	}
	if (haystack.includes("co-founder") || haystack.includes("cofounder")) {
		confidence += 25;
		reasons.push("cofounder language");
	}
	if (haystack.includes(normalized)) {
		confidence += 15;
		reasons.push("message text matches query");
		profileEvidence.push({
			kind: "dm_context",
			value: query,
			source: "dm",
		});
	}
	if (
		expansions.some((item) => item.finalUrl.toLowerCase().includes(normalized))
	) {
		confidence += 15;
		reasons.push("expanded URL matches query");
		for (const item of expansions) {
			pushMatchEvidence(
				profileEvidence,
				normalized,
				"expanded_url",
				item.finalUrl,
				"url",
			);
		}
	}

	return {
		confidence: Math.min(100, confidence),
		reasons: reasons.length > 0 ? reasons : ["local DM match"],
		profileEvidence,
	};
}

function attachExpansionsToMatches(
	conversation: DmConversationItem,
	expansions: UrlExpansionItem[],
) {
	for (const match of conversation.matches ?? []) {
		const matchUrls = new Set(
			[...match.before, match.message, ...match.after].flatMap((message) =>
				expansions
					.filter((item) => message.text.includes(item.url))
					.map((item) => item.url),
			),
		);
		if (matchUrls.size > 0) {
			match.urlExpansions = expansions.filter((item) =>
				matchUrls.has(item.url),
			);
		}
	}
}

export async function runWhois(
	query: string,
	options: WhoisOptions = {},
): Promise<WhoisResult> {
	const includeDms = options.dms ?? true;
	const includeTweets = options.tweets ?? false;
	const limit = options.limit ?? 10;
	const context = options.context ?? 4;
	let conversations = includeDms
		? listDmConversations({
				account: options.account,
				search: query,
				context,
				limit,
			})
		: [];
	let profileResolution: WhoisResult["profileResolution"];

	if (options.resolveProfiles ?? true) {
		profileResolution = await resolveProfilesForIds(
			conversations.map((item) => item.participant.id),
			{
				refresh: options.refreshProfileCache,
				xurlFallback: options.xurlFallback ?? true,
			},
		);
		conversations = includeDms
			? listDmConversations({
					account: options.account,
					search: query,
					context,
					limit,
				})
			: [];
	}

	const relatedTweets = includeTweets
		? [
				...listTimelineItems({
					resource: "home",
					account: options.account,
					search: query,
					limit,
				}),
				...listTimelineItems({
					resource: "mentions",
					account: options.account,
					search: query,
					limit,
				}),
			]
		: [];

	const texts = [
		...conversations.flatMap(getMessageTexts),
		...conversations.flatMap((conversation) =>
			[
				conversation.participant.bio,
				conversation.participant.url ?? "",
				...getProfileBioUrls(conversation.participant),
			].filter((text) => text.includes("https://t.co/")),
		),
		...relatedTweets.map((tweet) => tweet.text),
	];
	const urlExpansions =
		(options.expandUrls ?? true)
			? await expandUrlsFromTexts(texts, { refresh: options.refreshUrlCache })
			: [];
	for (const conversation of conversations) {
		attachExpansionsToMatches(conversation, urlExpansions);
	}

	const candidates = conversations
		.map((conversation): WhoisCandidate => {
			const conversationExpansions = urlExpansions.filter((item) =>
				getMessageTexts(conversation).some((text) => text.includes(item.url)),
			);
			const score = scoreCandidate(query, conversation, conversationExpansions);
			return {
				conversation,
				confidence: score.confidence,
				reasons: score.reasons,
				profileEvidence: score.profileEvidence,
				evidence: (conversation.matches ?? []).map((match) => ({
					messageId: match.message.id,
					createdAt: match.message.createdAt,
					direction: match.message.direction,
					text: match.message.text,
					...(match.urlExpansions
						? { urlExpansions: match.urlExpansions }
						: {}),
				})),
			};
		})
		.sort((left, right) => {
			if (right.confidence !== left.confidence) {
				return right.confidence - left.confidence;
			}
			return (
				new Date(right.conversation.lastMessageAt).getTime() -
				new Date(left.conversation.lastMessageAt).getTime()
			);
		});

	return {
		query,
		candidates,
		relatedTweets,
		urlExpansions,
		...(profileResolution ? { profileResolution } : {}),
	};
}

export function formatWhois(result: WhoisResult) {
	const lines = [`Whois: ${result.query}`];
	if (result.candidates.length === 0) {
		lines.push("No matching DM candidates.");
	} else {
		for (const candidate of result.candidates) {
			const profile = candidate.conversation.participant;
			lines.push("");
			lines.push(
				`${candidate.confidence}% @${profile.handle} (${profile.displayName})`,
			);
			lines.push(`Reasons: ${candidate.reasons.join(", ")}`);
			lines.push(`Conversation: ${candidate.conversation.id}`);
			for (const signal of candidate.profileEvidence.slice(0, 5)) {
				lines.push(`Evidence: ${signal.kind}: ${signal.value}`);
			}
			for (const evidence of candidate.evidence.slice(0, 3)) {
				lines.push(
					`- ${evidence.createdAt} ${evidence.direction}: ${evidence.text}`,
				);
				for (const expansion of evidence.urlExpansions ?? []) {
					lines.push(`  ${expansion.url} -> ${expansion.finalUrl}`);
				}
			}
		}
	}

	if (result.relatedTweets.length > 0) {
		lines.push("");
		lines.push(`Related tweets: ${result.relatedTweets.length}`);
		for (const tweet of result.relatedTweets.slice(0, 5)) {
			lines.push(`- ${tweet.createdAt} @${tweet.author.handle}: ${tweet.text}`);
		}
	}

	return lines.join("\n");
}
