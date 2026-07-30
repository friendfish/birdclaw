import { z } from "zod";

export const periodDigestSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	keyTopics: z.array(
		z.object({
			title: z.string().min(1),
			summary: z.string().min(1),
			tweetIds: z.array(z.string()).default([]),
			handles: z.array(z.string()).default([]),
		}),
	),
	notableLinks: z.array(
		z.object({
			title: z.string().min(1),
			url: z.string().min(1),
			why: z.string().min(1),
			sourceTweetIds: z.array(z.string()).default([]),
		}),
	),
	people: z.array(
		z.object({
			handle: z.string().min(1),
			name: z.string().optional(),
			why: z.string().min(1),
		}),
	),
	actionItems: z.array(
		z.object({
			kind: z.enum(["reply", "follow_up", "read", "sync"]),
			label: z.string().min(1),
			tweetId: z.string().optional(),
			dmConversationId: z.string().optional(),
		}),
	),
	sourceTweetIds: z.array(z.string()).default([]),
});

export const profileAnalysisSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	voice: z.string().min(1),
	themes: z.array(
		z.object({
			title: z.string().min(1),
			summary: z.string().min(1),
			tweetIds: z.array(z.string()).default([]),
			handles: z.array(z.string()).default([]),
		}),
	),
	conversationStyle: z.string().min(1),
	notableSignals: z.array(z.string()).default([]),
	risks: z.array(z.string()).default([]),
	followUps: z.array(z.string()).default([]),
	sourceTweetIds: z.array(z.string()).default([]),
	sourceHandles: z.array(z.string()).default([]),
});

export const searchDiscussionSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	themes: z.array(
		z.object({
			title: z.string().min(1),
			summary: z.string().min(1),
			tweetIds: z.array(z.string()).default([]),
			dmConversationIds: z.array(z.string()).default([]),
			handles: z.array(z.string()).default([]),
		}),
	),
	tensions: z.array(z.string()).default([]),
	followUps: z.array(z.string()).default([]),
	sourceTweetIds: z.array(z.string()).default([]),
	sourceDmConversationIds: z.array(z.string()).default([]),
});

export type PeriodDigest = z.infer<typeof periodDigestSchema>;
export type ProfileAnalysis = z.infer<typeof profileAnalysisSchema>;
export type SearchDiscussion = z.infer<typeof searchDiscussionSchema>;
