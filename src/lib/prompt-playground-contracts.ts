import { z } from "zod";
import {
	periodDigestSchema,
	profileAnalysisSchema,
	searchDiscussionSchema,
} from "./analysis-result-contracts";
import type { PeriodDigestPlaygroundResult } from "./period-digest";
import type { PlaygroundStreamEvent } from "./prompt-playground";
import type { ProfileAnalysisPlaygroundResult } from "./profile-analysis";
import type { SearchDiscussionPlaygroundResult } from "./search-discussion";

const MAX_SYSTEM_LENGTH = 20_000;
const MAX_REQUIREMENTS_LENGTH = 100_000;

export const promptFeatureSchema = z.enum([
	"period-digest",
	"profile-analysis",
	"search-discussion",
]);

export const editablePromptSchema = z.object({
	system: z.string().trim().min(1).max(MAX_SYSTEM_LENGTH),
	requirements: z.string().trim().min(1).max(MAX_REQUIREMENTS_LENGTH),
});

export const promptTemplateSaveRequestSchema = z.strictObject({
	feature: promptFeatureSchema,
	system: z.string().trim().min(1).max(MAX_SYSTEM_LENGTH),
	requirements: z.string().trim().min(1).max(MAX_REQUIREMENTS_LENGTH),
});

export const promptTemplateResetRequestSchema = z.strictObject({
	feature: promptFeatureSchema,
});

export const promptTemplateResponseSchema = z.object({
	ok: z.literal(true),
	template: z.object({
		feature: promptFeatureSchema,
		system: z.string(),
		requirements: z.string(),
		isCustom: z.boolean(),
		schemaVersion: z.number().int(),
		parseError: z.string().optional(),
	}),
	definition: z.object({
		label: z.string(),
		description: z.string(),
		protocol: z.object({
			system: z.string(),
			taskInstruction: z.string(),
			requirements: z.string(),
		}),
	}),
});

const periodDigestPlaygroundResultSchema: z.ZodType<PeriodDigestPlaygroundResult> =
	z.object({
		markdown: z.string(),
		digest: periodDigestSchema,
		parseStatus: z.enum(["structured", "fallback"]),
		generatedAt: z.string(),
	});

const searchDiscussionPlaygroundResultSchema: z.ZodType<SearchDiscussionPlaygroundResult> =
	z.object({
		markdown: z.string(),
		discussion: searchDiscussionSchema,
		parseStatus: z.enum(["structured", "fallback"]),
		generatedAt: z.string(),
	});

export const profileAnalysisPlaygroundResponseSchema: z.ZodType<{
	ok: true;
	result: ProfileAnalysisPlaygroundResult;
}> = z.object({
	ok: z.literal(true),
	result: z.object({
		markdown: z.string(),
		analysis: profileAnalysisSchema,
		parseStatus: z.enum(["structured", "fallback"]),
		generatedAt: z.string(),
	}),
});

function playgroundStreamEventSchema<T>(
	result: z.ZodType<T>,
): z.ZodType<PlaygroundStreamEvent<T>> {
	return z.discriminatedUnion("type", [
		z.object({ type: z.literal("delta"), delta: z.string() }),
		z.object({ type: z.literal("done"), result }),
		z.object({ type: z.literal("error"), error: z.string() }),
	]);
}

export const periodDigestPlaygroundStreamEventSchema =
	playgroundStreamEventSchema(periodDigestPlaygroundResultSchema);

export const searchDiscussionPlaygroundStreamEventSchema =
	playgroundStreamEventSchema(searchDiscussionPlaygroundResultSchema);

export const periodDigestPlaygroundRequestSchema = z.object({
	period: z.enum(["today", "yesterday", "24h", "week"]),
	contentSource: z.enum(["all", "for_you", "following"]),
	includeDms: z.boolean().optional(),
	account: z.string().trim().min(1).max(256).optional(),
	language: z.string().trim().min(1).max(64).optional(),
	...editablePromptSchema.shape,
});

export const profileAnalysisPlaygroundRequestSchema = z.object({
	handle: z.string().trim().min(1).max(64),
	account: z.string().trim().min(1).max(256).optional(),
	language: z.string().trim().min(1).max(64).optional(),
	...editablePromptSchema.shape,
});

export const searchDiscussionPlaygroundRequestSchema = z.object({
	query: z.string().trim().min(1).max(1_000),
	source: z
		.enum([
			"all",
			"home",
			"mentions",
			"authored",
			"search",
			"likes",
			"bookmarks",
		])
		.optional(),
	includeDms: z.boolean().optional(),
	question: z.string().trim().max(4_000).optional(),
	account: z.string().trim().min(1).max(256).optional(),
	...editablePromptSchema.shape,
});

export type PromptTemplateResponse = z.infer<
	typeof promptTemplateResponseSchema
>;
export type ProfileAnalysisPlaygroundResponse = z.infer<
	typeof profileAnalysisPlaygroundResponseSchema
>;
