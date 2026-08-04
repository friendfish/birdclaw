import type { ExecFileOptions } from "node:child_process";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	mergeBirdCredentialEnvironment,
	readBirdCredentials,
} from "#/lib/bird-credentials";
import { runBirdCommand } from "#/lib/bird-command";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { sensitiveErrorMessage } from "#/lib/sensitive-values";

export interface BirdCredentialsTestDependencies {
	runBirdCommand: (
		args: string[],
		options?: ExecFileOptions,
	) => Promise<{ stdout: string; stderr: string }>;
}

const defaultDependencies: BirdCredentialsTestDependencies = {
	runBirdCommand,
};

function sanitizedTestError(
	error: unknown,
	credentials: { authToken: string; ct0: string },
) {
	let message = sensitiveErrorMessage(error);
	for (const secret of [credentials.authToken, credentials.ct0]) {
		if (secret) message = message.replaceAll(secret, "[REDACTED]");
	}
	return message || "Credential test failed";
}

export function testBirdCredentials(
	request: Request,
	dependencies: BirdCredentialsTestDependencies = defaultDependencies,
) {
	return runRouteEffect(
		Effect.gen(function* () {
			const denied = sensitiveRequestErrorResponse(request);
			if (denied) return denied;

			const credentials = readBirdCredentials();
			if (!credentials) {
				return jsonResponse(
					{ ok: false, error: "X credentials are not configured" },
					{ status: 400 },
				);
			}

			return yield* Effect.tryPromise({
				try: () =>
					dependencies.runBirdCommand(["whoami"], {
						env: mergeBirdCredentialEnvironment(),
					}),
				catch: (cause) => cause,
			}).pipe(
				Effect.match({
					onFailure: (error) =>
						jsonResponse(
							{
								ok: false,
								error: sanitizedTestError(error, credentials),
							},
							{ status: 502 },
						),
					onSuccess: () => jsonResponse({ ok: true }),
				}),
			);
		}),
	);
}

export const Route = createFileRoute("/api/bird-credentials-test")({
	server: {
		handlers: {
			POST: ({ request }) => testBirdCredentials(request),
		},
	},
});
