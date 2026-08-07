import type { PeriodDigest } from "./analysis-result-contracts";

export interface DisplayablePeriodDigestInput {
	digest: PeriodDigest;
	markdown: string;
	parseStatus: "structured" | "fallback";
}

const LANGUAGE_MARKER = /^\[[^\]\r\n]+\]$/;
const NO_MODEL_SUMMARY = "No model summary was returned.";

function hasDisplayText(value: string) {
	return value.trim().length > 0;
}

function hasStructuredDetails(digest: PeriodDigest) {
	return (
		digest.keyTopics.some(
			(topic) => hasDisplayText(topic.title) && hasDisplayText(topic.summary),
		) ||
		digest.notableLinks.some(
			(link) =>
				hasDisplayText(link.title) &&
				hasDisplayText(link.url) &&
				hasDisplayText(link.why),
		) ||
		digest.people.some(
			(person) => hasDisplayText(person.handle) && hasDisplayText(person.why),
		) ||
		digest.actionItems.some((action) => hasDisplayText(action.label))
	);
}

function isPlaceholderOnlyDigest(digest: PeriodDigest) {
	if (hasStructuredDetails(digest)) return false;
	const title = digest.title.trim();
	const summary = digest.summary.trim();
	return (
		(LANGUAGE_MARKER.test(title) && LANGUAGE_MARKER.test(summary)) ||
		summary === NO_MODEL_SUMMARY
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
