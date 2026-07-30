import { describe, expect, it } from "vitest";
import {
	periodDigestPlaygroundStreamEventSchema,
	profileAnalysisPlaygroundResponseSchema,
	promptTemplateResetRequestSchema,
	searchDiscussionPlaygroundStreamEventSchema,
} from "./prompt-playground-contracts";
import {
	periodDigestStreamEventSchema,
	profileAnalysisStreamEventSchema,
	searchDiscussionStreamEventSchema,
} from "./client-stream-contracts";

const formalDoneEvent = {
	type: "done",
	result: {
		context: {
			handle: "alice",
			profile: { handle: "alice" },
			tweets: [],
			conversations: [],
			includeDms: false,
			counts: {
				home: 0,
				mentions: 0,
				links: 0,
				dms: 0,
				search: 0,
				authored: 0,
				likes: 0,
				bookmarks: 0,
				conversationTweets: 0,
				conversationsScanned: 0,
			},
		},
		markdown: "Report",
		cached: false,
	},
};

describe("prompt playground contracts", () => {
	it("requires parseStatus in every formal done event", () => {
		for (const schema of [
			periodDigestStreamEventSchema,
			profileAnalysisStreamEventSchema,
			searchDiscussionStreamEventSchema,
		]) {
			expect(schema.safeParse(formalDoneEvent).success).toBe(false);
		}
	});

	it("requires parseStatus in all playground results", () => {
		const streamEvent = {
			type: "done",
			result: {
				markdown: "Report",
				digest: {},
				discussion: {},
				generatedAt: new Date().toISOString(),
			},
		};
		expect(
			periodDigestPlaygroundStreamEventSchema.safeParse(streamEvent).success,
		).toBe(false);
		expect(
			searchDiscussionPlaygroundStreamEventSchema.safeParse(streamEvent)
				.success,
		).toBe(false);
		expect(
			profileAnalysisPlaygroundResponseSchema.safeParse({
				ok: true,
				result: {
					markdown: "Report",
					analysis: {},
					generatedAt: new Date().toISOString(),
				},
			}).success,
		).toBe(false);
	});

	it("rejects incomplete nested playground results", () => {
		const generatedAt = new Date().toISOString();
		expect(
			periodDigestPlaygroundStreamEventSchema.safeParse({
				type: "done",
				result: {
					markdown: "Report",
					digest: {},
					parseStatus: "structured",
					generatedAt,
				},
			}).success,
		).toBe(false);
		expect(
			searchDiscussionPlaygroundStreamEventSchema.safeParse({
				type: "done",
				result: {
					markdown: "Report",
					discussion: {},
					parseStatus: "structured",
					generatedAt,
				},
			}).success,
		).toBe(false);
		expect(
			profileAnalysisPlaygroundResponseSchema.safeParse({
				ok: true,
				result: {
					markdown: "Report",
					analysis: {},
					parseStatus: "structured",
					generatedAt,
				},
			}).success,
		).toBe(false);
	});

	it("keeps reset as a strict feature-only request", () => {
		expect(
			promptTemplateResetRequestSchema.safeParse({
				feature: "period-digest",
			}).success,
		).toBe(true);
		expect(
			promptTemplateResetRequestSchema.safeParse({
				feature: "period-digest",
				system: "accidental",
			}).success,
		).toBe(false);
	});
});
