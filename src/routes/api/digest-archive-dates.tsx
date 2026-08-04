import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { resolveDigestArchiveDir } from "#/lib/config";
import { listDigestArchiveDatesEffect } from "#/lib/digest-archive-job";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import type { PeriodDigestPreset } from "#/lib/period-digest";

function parsePeriod(value: string | null): PeriodDigestPreset {
	return value === "today" ||
		value === "24h" ||
		value === "yesterday" ||
		value === "week"
		? value
		: "yesterday";
}

export const Route = createFileRoute("/api/digest-archive-dates")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const url = new URL(request.url);
						const period = parsePeriod(url.searchParams.get("period"));
						const archiveDir = resolveDigestArchiveDir();
						const dates = yield* listDigestArchiveDatesEffect({
							archiveDir,
							period,
						});
						return jsonResponse({ ok: true, dates });
					}),
				),
		},
	},
});
