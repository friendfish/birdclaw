import { describe, expect, test } from "vitest";
import type { PeriodDigest } from "./analysis-result-contracts";
import {
	assertDisplayablePeriodDigest,
	isDisplayablePeriodDigest,
} from "./period-digest-integrity";

function digest(overrides: Partial<PeriodDigest> = {}): PeriodDigest {
	return {
		title: "Today digest",
		summary: "A useful summary of the period.",
		keyTopics: [],
		notableLinks: [],
		people: [],
		actionItems: [],
		sourceTweetIds: [],
		...overrides,
	};
}

describe("period digest displayability", () => {
	test("accepts valid structured content with non-empty Markdown", () => {
		expect(
			isDisplayablePeriodDigest({
				digest: digest(),
				markdown: "# Today digest",
				parseStatus: "structured",
			}),
		).toBe(true);
	});

	test("accepts useful fallback prose without structured detail arrays", () => {
		expect(
			isDisplayablePeriodDigest({
				digest: digest({ summary: "The main discussion focused on releases." }),
				markdown: "The main discussion focused on releases.",
				parseStatus: "fallback",
			}),
		).toBe(true);
	});

	test.each(["", " \n\t "])(
		"rejects blank Markdown regardless of parse status: %j",
		(markdown) => {
			expect(
				isDisplayablePeriodDigest({
					digest: digest(),
					markdown,
					parseStatus: "structured",
				}),
			).toBe(false);
			expect(
				isDisplayablePeriodDigest({
					digest: digest(),
					markdown,
					parseStatus: "fallback",
				}),
			).toBe(false);
		},
	);

	test("rejects a placeholder-only language marker digest", () => {
		expect(
			isDisplayablePeriodDigest({
				digest: digest({ title: "[zh-CN]", summary: "[zh-CN]" }),
				markdown: "# Placeholder shell",
				parseStatus: "structured",
			}),
		).toBe(false);
	});

	test("rejects the no-model-summary fallback sentinel", () => {
		expect(
			isDisplayablePeriodDigest({
				digest: digest({ summary: "No model summary was returned." }),
				markdown: "# Placeholder shell",
				parseStatus: "fallback",
			}),
		).toBe(false);
	});

	test("does not treat source tweet IDs as displayable semantic content", () => {
		expect(
			isDisplayablePeriodDigest({
				digest: digest({
					title: "[zh-CN]",
					summary: "[zh-CN]",
					sourceTweetIds: ["tweet_1"],
				}),
				markdown: "# Placeholder shell",
				parseStatus: "structured",
			}),
		).toBe(false);
	});

	test("accepts placeholder text when structured details are present and Markdown is nonblank", () => {
		const digests = [
			digest({
				title: "[zh-CN]",
				summary: "[zh-CN]",
				keyTopics: [
					{
						title: "Release notes",
						summary: "A release was announced.",
						tweetIds: [],
						handles: [],
					},
				],
			}),
			digest({
				title: "[zh-CN]",
				summary: "[zh-CN]",
				notableLinks: [
					{
						title: "Release notes",
						url: "https://example.com/release-notes",
						why: "Explains the release.",
						sourceTweetIds: [],
					},
				],
			}),
			digest({
				title: "[zh-CN]",
				summary: "[zh-CN]",
				people: [{ handle: "birdclaw", why: "Shared an update." }],
			}),
			digest({
				title: "[zh-CN]",
				summary: "[zh-CN]",
				actionItems: [{ kind: "read", label: "Read the release notes" }],
			}),
		];

		for (const value of digests) {
			expect(
				isDisplayablePeriodDigest({
					digest: value,
					markdown: "# Release notes",
					parseStatus: "structured",
				}),
			).toBe(true);
		}
	});

	test("still rejects placeholder text with structured details when Markdown is blank", () => {
		expect(() =>
			assertDisplayablePeriodDigest({
				digest: digest({
					title: "[zh-CN]",
					summary: "[zh-CN]",
					people: [{ handle: "birdclaw", why: "Shared an update." }],
				}),
				markdown: " \n\t ",
				parseStatus: "structured",
			}),
		).toThrow("Period digest did not contain displayable content");
	});

	test("throws the exact displayability error for invalid inputs", () => {
		let thrown: unknown;
		try {
			assertDisplayablePeriodDigest({
				digest: digest({ title: "[zh-CN]", summary: "[zh-CN]" }),
				markdown: "# Placeholder shell",
				parseStatus: "structured",
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe(
			"Period digest did not contain displayable content",
		);
	});
});
