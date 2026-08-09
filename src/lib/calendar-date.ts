export function isCalendarDateString(value: unknown): value is string {
	// Birdclaw's archive contract uses four-digit civil years 0001 through 9999.
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
		value.startsWith("0000-")
	) {
		return false;
	}

	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !(
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== value
	);
}
