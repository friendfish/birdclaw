import { Effect } from "effect";
import { lookupTweetsByIdsViaBirdEffect } from "./bird";
import { runEffectPromise } from "./effect-runtime";
import { resolveLiveSyncMode } from "./live-transport-policy";
import type { XurlTweetsResponse } from "./types";
import { lookupTweetsByIdsEffect as lookupTweetsByIdsViaXurlEffect } from "./xurl";

export type TweetLookupMode = "auto" | "xurl" | "bird";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function lookupTweetsByIdsEffect(
	ids: string[],
	mode?: TweetLookupMode,
): Effect.Effect<XurlTweetsResponse, unknown> {
	const resolvedMode = resolveLiveSyncMode(mode);
	if (resolvedMode === "bird") {
		return lookupTweetsByIdsViaBirdEffect(ids);
	}
	if (resolvedMode === "xurl") {
		return lookupTweetsByIdsViaXurlEffect(ids);
	}

	return lookupTweetsByIdsViaXurlEffect(ids).pipe(
		Effect.catchAll((xurlError) =>
			lookupTweetsByIdsViaBirdEffect(ids).pipe(
				Effect.catchAll((birdError) =>
					Effect.fail(
						new Error(
							`Tweet lookup failed via xurl and bird: xurl: ${errorMessage(
								xurlError,
							)}; bird: ${errorMessage(birdError)}`,
						),
					),
				),
			),
		),
	);
}

export function lookupTweetsByIds(
	ids: string[],
	mode?: TweetLookupMode,
): Promise<XurlTweetsResponse> {
	return runEffectPromise(lookupTweetsByIdsEffect(ids, mode));
}
