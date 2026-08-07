// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	periodDigestMetadataPollInterval,
	periodDigestMetadataResponseSchema,
} from "./usePeriodDigestMetadata";

const STREAM_DIAGNOSTICS = {
	responseId: "resp-client",
	finishReason: "stop",
	visibleTextLength: 42,
	reasoningTextLength: 7,
};

function metadataResponse(diagnostics: unknown) {
	return {
		ok: true,
		isGenerating: false,
		isStale: false,
		activeStatus: null,
		result: {
			context: {},
			digest: {},
			markdown: "# Today",
			model: "gpt-5.5",
			reasoningEffort: "medium",
			serviceTier: "priority",
			parseStatus: "structured",
			cached: true,
			updatedAt: "2026-08-06T08:00:00.000Z",
			diagnostics,
		},
		runState: null,
		migration: null,
	};
}

describe("period digest metadata polling", () => {
	it("polls slowly while idle and quickly while a batch is active", () => {
		expect(periodDigestMetadataPollInterval(false)).toBe(30_000);
		expect(periodDigestMetadataPollInterval(true)).toBe(3_000);
	});

	it("preserves valid stream diagnostics when parsing metadata", () => {
		const parsed = periodDigestMetadataResponseSchema.parse(
			metadataResponse(STREAM_DIAGNOSTICS),
		);

		expect(parsed.result?.diagnostics).toEqual(STREAM_DIAGNOSTICS);
	});

	it("rejects invalid stream diagnostics", () => {
		const parsed = periodDigestMetadataResponseSchema.safeParse(
			metadataResponse({
				visibleTextLength: Number.NaN,
				reasoningTextLength: -1,
			}),
		);

		expect(parsed.success).toBe(false);
	});
});
