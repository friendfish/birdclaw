import os from "node:os";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { resolveDigestArchiveDir } from "#/lib/config";
import {
	DEFAULT_LOCK_STALE_MS,
	digestArchiveLockPath,
	digestArchivePublicationLockPath,
	formatDigestArchiveRunDate,
	getDefaultDigestArchiveAuditLogPath,
	replaceDigestArchiveEntryEffect,
	resolveDigestArchiveLanguage,
} from "#/lib/digest-archive-job";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { readLatestPeriodDigestEffect } from "#/lib/period-digest";
import {
	acquireScheduledJobLockEffect,
	appendScheduledJobAuditEffect,
	peekScheduledJobLockMetadataEffect,
} from "#/lib/scheduled-job";

const manualSaveRequestSchema = z.object({
	period: z.enum(["today", "24h"]),
	contentSource: z.enum(["all", "for_you", "following"]),
	includeDms: z.boolean(),
	expectedUpdatedAt: z.string().refine(
		(value) => {
			const date = new Date(value);
			return Number.isFinite(date.getTime()) && date.toISOString() === value;
		},
		{ message: "Expected an ISO timestamp" },
	),
});

function errorResponse(error: string, status: number) {
	return jsonResponse({ ok: false, error }, { status });
}

export const Route = createFileRoute("/api/digest-archive-save")({
	server: {
		handlers: {
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const input = yield* requestJsonEffect(request, null);
						const parsed = manualSaveRequestSchema.safeParse(input);
						if (!parsed.success) {
							return errorResponse("Invalid digest archive save request.", 400);
						}
						const body = parsed.data;
						const archiveDir = resolveDigestArchiveDir();
						const runDate = formatDigestArchiveRunDate(new Date());
						const releasePublication = yield* acquireScheduledJobLockEffect(
							digestArchivePublicationLockPath({
								archiveDir,
								runDate,
								period: body.period,
								contentSource: body.contentSource,
							}),
							DEFAULT_LOCK_STALE_MS,
						);
						if (!releasePublication) {
							return errorResponse(
								"This digest archive entry is currently being saved.",
								409,
							);
						}

						return yield* Effect.gen(function* () {
							const activeOwner = yield* peekScheduledJobLockMetadataEffect(
								digestArchiveLockPath(body.period),
								DEFAULT_LOCK_STALE_MS,
							);
							if (activeOwner) {
								return errorResponse(
									"A scheduled digest is currently generating for this period.",
									409,
								);
							}

							const result = yield* readLatestPeriodDigestEffect({
								period: body.period,
								contentSource: body.contentSource,
								includeDms: body.includeDms,
							});
							if (!result) {
								return errorResponse(
									"No complete manually generated digest is available to save.",
									404,
								);
							}
							if (result.updatedAt !== body.expectedUpdatedAt) {
								return errorResponse(
									"The displayed digest is no longer the latest result. Refresh and try again.",
									409,
								);
							}

							const replacement = yield* replaceDigestArchiveEntryEffect({
								archiveDir,
								runDate,
								period: body.period,
								contentSource: body.contentSource,
								result,
								language: resolveDigestArchiveLanguage(),
								publicationLeaseHeld: true,
							});
							yield* appendScheduledJobAuditEffect(
								getDefaultDigestArchiveAuditLogPath(),
								{
									job: "digest-archive-manual-save",
									period: body.period,
									contentSource: body.contentSource,
									runDate,
									generatedAt: replacement.generatedAt,
									savedAt: replacement.savedAt,
									host: os.hostname(),
									pid: process.pid,
								},
							);

							return jsonResponse({
								ok: true,
								period: body.period,
								contentSource: body.contentSource,
								generatedAt: replacement.generatedAt,
								savedAt: replacement.savedAt,
							});
						}).pipe(Effect.ensuring(releasePublication()));
					}),
				),
		},
	},
});
