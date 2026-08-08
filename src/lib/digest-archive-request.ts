import type { PeriodDigestContentSource } from "./period-digest";

export type DigestArchivePeriod = "yesterday" | "week";

const ARCHIVE_DATE_ERROR =
	"Archive date must be a real date in YYYY-MM-DD format.";

export function parseDigestArchivePeriod(
	value: string | null,
): DigestArchivePeriod {
	if (value === null) return "yesterday";
	if (value === "yesterday" || value === "week") return value;
	if (value === "today" || value === "24h") {
		throw new Error(
			"Today and 24h are current views and do not have archives.",
		);
	}
	throw new Error("Archive period must be yesterday or week.");
}

export function parseDigestArchiveContentSource(
	value: string | null,
): PeriodDigestContentSource {
	if (value === null) return "all";
	if (value === "all" || value === "following" || value === "for_you") {
		return value;
	}
	throw new Error("Archive contentSource must be all, following, or for_you.");
}

export function parseDigestArchiveDate(value: string | null): string {
	if (
		!value ||
		!/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
		value.startsWith("0000-")
	) {
		throw new Error(ARCHIVE_DATE_ERROR);
	}

	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== value
	) {
		throw new Error(ARCHIVE_DATE_ERROR);
	}

	return value;
}

export function parseDigestArchiveEntryRequest(url: URL) {
	return {
		period: parseDigestArchivePeriod(url.searchParams.get("period")),
		contentSource: parseDigestArchiveContentSource(
			url.searchParams.get("contentSource"),
		),
		date: parseDigestArchiveDate(url.searchParams.get("date")),
	};
}
