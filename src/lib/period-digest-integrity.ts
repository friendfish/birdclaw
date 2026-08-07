import type { PeriodDigest } from "./analysis-result-contracts";

export interface DisplayablePeriodDigestInput {
	digest: PeriodDigest;
	markdown: string;
	parseStatus: "structured" | "fallback";
}

const LANGUAGE_MARKER = /^\[[^\]\r\n]+\]$/;
const NO_MODEL_SUMMARY = "No model summary was returned.";

function hasStructuredDetails(digest: PeriodDigest) {
	return (
		digest.keyTopics.length > 0 ||
		digest.notableLinks.length > 0 ||
		digest.people.length > 0 ||
		digest.actionItems.length > 0
	);
}

function isPlaceholderOnlyDigest(digest: PeriodDigest) {
	if (hasStructuredDetails(digest)) return false;
	return (
		(LANGUAGE_MARKER.test(digest.title) &&
			LANGUAGE_MARKER.test(digest.summary)) ||
		digest.summary === NO_MODEL_SUMMARY
	);
}

export function isDisplayablePeriodDigest(
	input: DisplayablePeriodDigestInput,
): boolean {
	return (
		input.markdown.trim().length > 0 && !isPlaceholderOnlyDigest(input.digest)
	);
}

export function assertDisplayablePeriodDigest(
	input: DisplayablePeriodDigestInput,
): void {
	if (!isDisplayablePeriodDigest(input)) {
		throw new Error("Period digest did not contain displayable content");
	}
}
