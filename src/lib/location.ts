const COMBINING_DIACRITIC_PATTERN = /[\u0300-\u036f]/g;
const COLLAPSED_WHITESPACE_PATTERN = /\s+/g;
const COORDINATE_CAPTURE_PATTERN =
	/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const LETTER_PATTERN = /[a-z]/i;
const URL_OR_HANDLE_PATTERN = /(https?:\/\/|@|[A-Z0-9._%+-]+@[A-Z0-9.-]+)/i;
const MONEY_PATTERN = /\$\s?\d/;
const EMOJI_BLOCK_PATTERN =
	/[\u{1f1e6}-\u{1f1ff}\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]/gu;

const GENERIC_LOCATIONS = new Set([
	"earth",
	"everywhere",
	"internet",
	"milky way",
	"n/a",
	"na",
	"none",
	"null",
	"online",
	"somewhere",
	"space",
	"the internet",
	"the world",
	"undefined",
	"world",
	"world wide web",
]);

const DROP_WORDS = new Set([
	"a",
	"an",
	"and",
	"anywhere",
	"around",
	"at",
	"between",
	"by",
	"everywhere",
	"global",
	"here",
	"in",
	"inside",
	"my",
	"near",
	"nearby",
	"of",
	"on",
	"remote",
	"somewhere",
	"the",
	"there",
	"where",
	"worldwide",
]);

const NON_LOCATION_PHRASES = [
	/\b(check(out)? my|follow me|newsletter|subscribe|readers)\b/i,
	/\b(in my (own )?head|right behind you|on my computer)\b/i,
	/\b(dev\/null|dev null|xcode|vim|screen|framebuffer)\b/i,
	/\b(blockchain|metaverse|omniverse|hyperamerica)\b/i,
];

function parseCoordinatesFromString(input: string) {
	const match = input.match(COORDINATE_CAPTURE_PATTERN);
	if (!match) return null;
	const lat = Number(match[1]);
	const lng = Number(match[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
	return { lat, lng };
}

function stripJunkWords(part: string) {
	const words = part
		.split(" ")
		.map((word) => word.trim())
		.filter((word) => word.length > 0);
	const kept = words.filter((word) => !DROP_WORDS.has(word));
	return kept.join(" ").replace(COLLAPSED_WHITESPACE_PATTERN, " ").trim();
}

export function normalizeLocationKey(input: string): string {
	const raw = String(input || "").trim();
	if (!raw) return "";

	if (URL_OR_HANDLE_PATTERN.test(raw) || MONEY_PATTERN.test(raw)) return "";
	for (const pattern of NON_LOCATION_PHRASES) {
		if (pattern.test(raw)) return "";
	}

	const coords = parseCoordinatesFromString(raw);
	if (coords) {
		return `coords:${Number(coords.lat.toFixed(6))},${Number(
			coords.lng.toFixed(6),
		)}`;
	}

	let value = raw
		.toLowerCase()
		.normalize("NFKD")
		.replace(COMBINING_DIACRITIC_PATTERN, "")
		.replace(EMOJI_BLOCK_PATTERN, "")
		.replace(/[|;]+/g, ",")
		.replace(/\s+(?:and|or|\/|-)\s+/g, ",")
		.replace(/[\\/]+/g, ",")
		.replace(/[“”"']/g, "")
		.replace(COLLAPSED_WHITESPACE_PATTERN, " ")
		.replace(/\s*,\s*/g, ",")
		.replace(/,+/g, ",")
		.replace(/[^a-z0-9, .-]/g, "")
		.replace(/^[,\s.-]+|[,\s.-]+$/g, "");

	if (!value || GENERIC_LOCATIONS.has(value)) return "";

	const parts = value
		.split(",")
		.map((part) => stripJunkWords(part.trim()))
		.filter((part) => part.length > 0 && !GENERIC_LOCATIONS.has(part));

	value = parts.join(",");
	if (!value || GENERIC_LOCATIONS.has(value)) return "";
	return value.length <= 100 ? value : "";
}

export function isMeaningfulLocation(input: string): boolean {
	const key = normalizeLocationKey(input);
	if (!key) return false;
	if (key.startsWith("coords:")) return true;
	return LETTER_PATTERN.test(key) && key.length >= 2 && key.length <= 100;
}

export function coordinatesFromLocationKey(key: string) {
	if (!key.startsWith("coords:")) return null;
	const parsed = parseCoordinatesFromString(key.slice("coords:".length));
	return parsed ? { ...parsed, provider: "coords" as const } : null;
}
