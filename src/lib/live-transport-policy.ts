import { resolveMentionsDataSource, type MentionsDataSource } from "./config";
import type { LiveDataSourceStatus, TransportStatus } from "./types";

export type LiveReadMode = Exclude<MentionsDataSource, "birdclaw">;

export function resolveLiveReadMode(
	requestedMode?: string,
	legacyDefault: LiveReadMode = "xurl",
): LiveReadMode {
	if (requestedMode !== undefined) {
		if (
			requestedMode === "auto" ||
			requestedMode === "bird" ||
			requestedMode === "xurl"
		) {
			return requestedMode;
		}
		throw new Error("--mode must be auto, bird, or xurl");
	}

	const source = resolveMentionsDataSource();
	return source === "birdclaw" ? legacyDefault : source;
}

export function xurlDisabledTransportStatus(): TransportStatus {
	return {
		installed: false,
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
