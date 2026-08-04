import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import {
	clearBirdCredentials,
	getBirdCredentialStatus,
	writeBirdCredentials,
} from "#/lib/bird-credentials";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { sensitiveErrorMessage } from "#/lib/sensitive-values";

const credentialRequestSchema = z
	.object({
		authToken: z
			.string()
			.min(1)
			.regex(/^[^\r\n]+$/u),
		ct0: z
			.string()
			.min(1)
			.regex(/^[^\r\n]+$/u),
	})
	.strict();

function statusResponse() {
	return jsonResponse({ ok: true, status: getBirdCredentialStatus() });
}

function sanitizedCredentialError(error: unknown, secrets: string[] = []) {
	let message = sensitiveErrorMessage(error);
	for (const secret of secrets) {
		if (secret) message = message.replaceAll(secret, "[REDACTED]");
	}
	return message || "Credential operation failed";
}

export const Route = createFileRoute("/api/bird-credentials")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const denied = sensitiveRequestErrorResponse(request);
						return denied ?? statusResponse();
					}),
				),
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const input = yield* requestJsonEffect<unknown>(request, null);
						const parsed = credentialRequestSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{
									ok: false,
									error:
										"Both AUTH_TOKEN and CT0 are required and cannot contain line breaks",
								},
								{ status: 400 },
							);
						}

						const { authToken, ct0 } = parsed.data;
						return yield* Effect.try({
							try: () => writeBirdCredentials({ authToken, ct0 }),
							catch: (cause) => cause,
						}).pipe(
							Effect.match({
								onFailure: (error) =>
									jsonResponse(
										{
											ok: false,
											error: sanitizedCredentialError(error, [authToken, ct0]),
										},
										{ status: 500 },
									),
								onSuccess: (status) => jsonResponse({ ok: true, status }),
							}),
						);
					}),
				),
			DELETE: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						return yield* Effect.try({
							try: clearBirdCredentials,
							catch: (cause) => cause,
						}).pipe(
							Effect.match({
								onFailure: (error) =>
									jsonResponse(
										{
											ok: false,
											error: sanitizedCredentialError(error),
										},
										{ status: 500 },
									),
								onSuccess: statusResponse,
							}),
						);
					}),
				),
		},
	},
});
