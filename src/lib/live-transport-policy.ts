import { resolveMentionsDataSource, type LiveDataSource } from "./config";
import type { LiveDataSourceStatus, TransportStatus } from "./types";

export type LiveReadMode = LiveDataSource;

type LiveReadCapability =
	| "xurl-first"
	| "sync"
	| "mention-threads"
	| "direct-messages";

const capabilityDefaults: Record<LiveReadCapability, LiveReadMode> = {
	"xurl-first": "xurl",
	sync: "auto",
	"mention-threads": "bird",
	"direct-messages": "bird",
};

function resolveModeForCapability(
	requestedMode: string | undefined,
	capability: LiveReadCapability,
): LiveReadMode {
	if (requestedMode !== undefined) {
		if (
			requestedMode === "auto" ||
			requestedMode === "bird" ||
			requestedMode === "xurl"
		) {
			return requestedMode;
		}
		throw new Error("Invalid live-read mode; expected auto, bird, or xurl");
	}

	const source = resolveMentionsDataSource();
	// Legacy birdclaw is an omitted global preference outside mention export to
	// preserve pre-policy behavior.
	return source === "birdclaw" ? capabilityDefaults[capability] : source;
}

export function resolveLiveReadMode(requestedMode?: string): LiveReadMode {
	return resolveModeForCapability(requestedMode, "xurl-first");
}

export function resolveLiveSyncMode(requestedMode?: string): LiveReadMode {
	return resolveModeForCapability(requestedMode, "sync");
}

export function resolveDirectMessagesReadMode(
	requestedMode?: string,
): LiveReadMode {
	return resolveModeForCapability(requestedMode, "direct-messages");
}

export function resolveMentionThreadReadMode(
	requestedMode?: string,
): Exclude<LiveReadMode, "auto"> {
	const mode = resolveModeForCapability(requestedMode, "mention-threads");
	if (mode === "auto") {
		throw new Error("Mention-thread sync supports only bird or xurl");
	}
	return mode;
}

export function xurlDisabledTransportStatus(): TransportStatus {
	return {
		availableTransport: "local",
		statusText: "xurl disabled by bird transport selection",
	};
}

export function xurlDisabledDataSourceStatus(): LiveDataSourceStatus {
	return {
		source: "xurl",
		label: "xurl",
		works: false,
		status: "warning",
		detail: "xurl disabled by bird transport selection",
		accounts: [],
	};
}
