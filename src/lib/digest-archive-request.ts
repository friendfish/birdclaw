import type {
	PeriodDigestContentSource,
	PeriodDigestPreset,
} from "./period-digest";
import { isCalendarDateString } from "./calendar-date";

export type DigestArchivePeriod = Exclude<PeriodDigestPreset, "today" | "24h">;

export class DigestArchiveRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DigestArchiveRequestError";
	}
}

export function digestArchiveRequestErrorMessageOrRethrow(
	error: unknown,
): string {
	if (!(error instanceof DigestArchiveRequestError)) throw error;
	return error.message;
}

const ARCHIVE_DATE_ERROR =
	"Archive date must be a real date in YYYY-MM-DD format.";

export function parseDigestArchivePeriod(
	value: string | null,
): DigestArchivePeriod {
	if (value === null) return "yesterday";
	if (value === "yesterday" || value === "week") return value;
	if (value === "today" || value === "24h") {
		throw new DigestArchiveRequestError(
			"Today and 24h are current views and do not have archives.",
		);
	}
	throw new DigestArchiveRequestError(
		"Archive period must be yesterday or week.",
	);
}

export function parseDigestArchiveContentSource(
	value: string | null,
): PeriodDigestContentSource {
	if (value === null) return "all";
	if (value === "all" || value === "following" || value === "for_you") {
		return value;
	}
	throw new DigestArchiveRequestError(
		"Archive contentSource must be all, following, or for_you.",
	);
}

export function parseDigestArchiveDate(value: string | null): string {
	if (isCalendarDateString(value)) return value;
	throw new DigestArchiveRequestError(ARCHIVE_DATE_ERROR);
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
