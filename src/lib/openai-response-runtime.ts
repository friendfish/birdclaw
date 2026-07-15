import { Effect } from "effect";
import { tryPromise } from "./effect-runtime";
import { getBirdclawConfig } from "./config";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";

const DEFAULT_DELIMITER_PATTERN = /\n---\s*\n/;
const DEFAULT_DELIMITER_HOLD = 8;

export interface OpenAIStreamState {
	eventBuffer: string;
	rawText: string;
	pendingVisible: string;
	jsonMode: boolean;
	responseId?: string;
	usage?: unknown;
	error?: string;
}

export interface OpenAIStreamResult {
	rawText: string;
	responseId?: string;
	usage?: unknown;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Resolve the OpenAI-compatible API base URL. Point this at Ollama
 * (`http://localhost:11434/v1`) or any other OpenAI-compatible server via
 * the Birdclaw-specific `BIRDCLAW_OPENAI_BASE_URL`. The previously shipped
 * `OPENAI_BASE_URL` setting remains a lower-priority compatibility fallback.
 * A trailing slash is trimmed so callers can safely append `/responses` etc.
 */
export function resolveOpenAIBaseUrl(
	getEnv: (name: string) => string | undefined,
): string {
	const configured =
		getEnv("BIRDCLAW_OPENAI_BASE_URL") || getEnv("OPENAI_BASE_URL");
	const base = configured?.trim() || DEFAULT_OPENAI_BASE_URL;
	return base.replace(/\/+$/, "");
}

/**
 * Emit an OpenAI-transport debug line to stderr when `BIRDCLAW_DEBUG` is set.
 * Gated so normal runs stay quiet; enable with `BIRDCLAW_DEBUG=1`.
 */
export function debugLog(
	getEnv: (name: string) => string | undefined,
	message: string,
) {
	if (!getEnv("BIRDCLAW_DEBUG")) return;
	if (typeof process === "undefined") return;
	process.stderr.write(`[birdclaw:openai] ${message}\n`);
}

export function createOpenAIStreamState(): OpenAIStreamState {
	return {
		eventBuffer: "",
		rawText: "",
		pendingVisible: "",
		jsonMode: false,
	};
}

function emitVisibleDelta(
	state: OpenAIStreamState,
	delta: string,
	onDelta: ((delta: string) => void) | undefined,
	delimiterPattern: RegExp,
	delimiterHold: number,
) {
	state.rawText += delta;
	if (state.jsonMode) return;

	const combined = state.pendingVisible + delta;
	const delimiterIndex = combined.search(delimiterPattern);
	if (delimiterIndex >= 0) {
		const visible = combined.slice(0, delimiterIndex);
		if (visible) onDelta?.(visible);
		state.pendingVisible = "";
		state.jsonMode = true;
		return;
	}

	if (combined.length <= delimiterHold) {
		state.pendingVisible = combined;
		return;
	}

	const visible = combined.slice(0, -delimiterHold);
	state.pendingVisible = combined.slice(-delimiterHold);
	if (visible) onDelta?.(visible);
}

function handleOpenAIEvent(
	state: OpenAIStreamState,
	event: Record<string, unknown>,
	onDelta: ((delta: string) => void) | undefined,
	delimiterPattern: RegExp,
	delimiterHold: number,
) {
	const type = typeof event.type === "string" ? event.type : "";
	if (
		type === "response.output_text.delta" &&
		typeof event.delta === "string"
	) {
		emitVisibleDelta(
			state,
			event.delta,
			onDelta,
			delimiterPattern,
			delimiterHold,
		);
		return;
	}
	if (type === "response.completed") {
		const response = event.response;
		if (response && typeof response === "object") {
			const record = response as Record<string, unknown>;
			state.responseId = typeof record.id === "string" ? record.id : undefined;
			state.usage = record.usage;
		}
		return;
	}
	if (type === "response.error" || type === "error") {
		const error = event.error;
		state.error =
			error && typeof error === "object" && "message" in error
				? String((error as { message?: unknown }).message)
				: "OpenAI stream failed";
		return;
	}
	if (type === "response.failed" || type === "response.incomplete") {
		const response = event.response;
		const record =
			response && typeof response === "object"
				? (response as Record<string, unknown>)
				: {};
		const error = record.error;
		const incomplete = record.incomplete_details;
		state.error =
			error && typeof error === "object" && "message" in error
				? String((error as { message?: unknown }).message)
				: incomplete && typeof incomplete === "object" && "reason" in incomplete
					? `OpenAI response incomplete: ${String((incomplete as { reason?: unknown }).reason)}`
					: "OpenAI stream failed";
	}
}

export function processOpenAIResponseSseChunk(
	state: OpenAIStreamState,
	chunk: string,
	{
		onDelta,
		delimiterPattern = DEFAULT_DELIMITER_PATTERN,
		delimiterHold = DEFAULT_DELIMITER_HOLD,
	}: {
		onDelta?: (delta: string) => void;
		delimiterPattern?: RegExp;
		delimiterHold?: number;
	} = {},
) {
	state.eventBuffer += chunk;
	let boundary = state.eventBuffer.indexOf("\n\n");
	while (boundary >= 0) {
		const block = state.eventBuffer.slice(0, boundary);
		state.eventBuffer = state.eventBuffer.slice(boundary + 2);
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data && data !== "[DONE]") {
			try {
				let parsed = JSON.parse(data) as Record<string, unknown>;
				let shouldHandle = true;
				if (Array.isArray(parsed.choices)) {
					const choice = parsed.choices[0] as
						| Record<string, unknown>
						| undefined;
					if (choice) {
						const delta = choice.delta as Record<string, unknown> | undefined;
						if (delta && typeof delta.content === "string") {
							parsed = {
								type: "response.output_text.delta",
								delta: delta.content,
							};
						} else if (choice.finish_reason || parsed.usage) {
							parsed = {
								type: "response.completed",
								response: {
									id: typeof parsed.id === "string" ? parsed.id : "chatcmpl",
									usage: parsed.usage,
								},
							};
						} else {
							shouldHandle = false;
						}
					}
				}
				if (shouldHandle) {
					handleOpenAIEvent(
						state,
						parsed,
						onDelta,
						delimiterPattern,
						delimiterHold,
					);
				}
			} catch {
				// The feature parser decides whether partial output remains usable.
			}
		}
		boundary = state.eventBuffer.indexOf("\n\n");
	}
}

export function readOpenAIResponseStreamEffect(
	response: Response,
	options: {
		onDelta?: (delta: string) => void;
		delimiterPattern?: RegExp;
		delimiterHold?: number;
	} = {},
): Effect.Effect<OpenAIStreamResult, Error> {
	const reader = response.body?.getReader();
	if (!reader) {
		return Effect.fail(new Error("OpenAI response did not include a stream"));
	}
	const decoder = new TextDecoder();

	return Effect.gen(function* () {
		const state = createOpenAIStreamState();
		for (;;) {
			const { done, value } = yield* tryPromise(() => reader.read()).pipe(
				Effect.mapError(toError),
			);
			if (!done) {
				processOpenAIResponseSseChunk(
					state,
					decoder.decode(value, { stream: true }),
					options,
				);
				continue;
			}
			if (!state.jsonMode && state.pendingVisible) {
				options.onDelta?.(state.pendingVisible);
			}
			if (state.error) {
				return yield* Effect.fail(new Error(state.error));
			}
			return {
				rawText: state.rawText,
				...(state.responseId ? { responseId: state.responseId } : {}),
				...(state.usage === undefined ? {} : { usage: state.usage }),
			};
		}
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				reader.releaseLock();
			}),
		),
	);
}

export function requestOpenAIResponseEffect({
	body,
	signal,
	runtime = defaultRuntimeServices,
}: {
	body: unknown;
	signal?: AbortSignal;
	runtime?: RuntimeServices;
}): Effect.Effect<Response, Error> {
	return Effect.gen(function* () {
		const aiConfig = getBirdclawConfig().ai || {};
		const apiKey = aiConfig.apiKey?.trim() || runtime.env("OPENAI_API_KEY");
		if (!apiKey) {
			return yield* Effect.fail(new Error("OPENAI_API_KEY is not set"));
		}
		const baseUrl =
			aiConfig.baseUrl?.trim() || resolveOpenAIBaseUrl(runtime.env);
		const apiType = runtime
			.env("BIRDCLAW_OPENAI_API_TYPE")
			?.trim()
			.toLowerCase();
		const isChatCompletion =
			apiType === "chat" ||
			apiType === "chat/completions" ||
			aiConfig.provider === "deepseek" ||
			aiConfig.provider === "google" ||
			aiConfig.provider === "openrouter" ||
			(baseUrl !== DEFAULT_OPENAI_BASE_URL && apiType !== "responses");

		const url = isChatCompletion
			? `${baseUrl}/chat/completions`
			: `${baseUrl}/responses`;
		let finalBody = body;
		if (isChatCompletion && body && typeof body === "object") {
			const { input, max_output_tokens, ...rest } = body as Record<string, any>;
			finalBody = {
				...rest,
				messages: Array.isArray(input) ? input : [],
				...(max_output_tokens !== undefined
					? { max_tokens: max_output_tokens }
					: {}),
			};

			// Google Gemini, OpenRouter, DeepSeek and other third-party OpenAI-compatible endpoints
			// do not support OpenAI Responses API specific / proprietary fields and fail with 400.
			// Specifically, Google Gemini rejects any unknown JSON keys.
			const isStrictOpenAICompatible =
				aiConfig.provider === "google" ||
				aiConfig.provider === "openrouter" ||
				aiConfig.provider === "deepseek" ||
				baseUrl.includes("googleapis.com") ||
				baseUrl.includes("openrouter.ai") ||
				baseUrl.includes("deepseek.com") ||
				(baseUrl !== DEFAULT_OPENAI_BASE_URL && aiConfig.provider !== "openai");

			if (isStrictOpenAICompatible) {
				delete (finalBody as any).reasoning;
				delete (finalBody as any).store;
				delete (finalBody as any).service_tier;
			}
		}

		debugLog(runtime.env, `POST ${url}`);
		const response = yield* tryPromise(() =>
			runtime.fetch(url, {
				method: "POST",
				signal,
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(finalBody),
			}),
		).pipe(
			Effect.mapError(toError),
			Effect.tapError((error) =>
				Effect.sync(() =>
					debugLog(runtime.env, `network error for ${url}: ${error.message}`),
				),
			),
		);
		if (!response.ok) {
			const text = yield* tryPromise(() => response.text()).pipe(
				Effect.mapError(toError),
			);
			debugLog(
				runtime.env,
				`${url} -> ${String(response.status)} ${text.slice(0, 400)}`,
			);
			return yield* Effect.fail(
				new Error(
					`OpenAI request failed: ${String(response.status)} ${text.slice(0, 400)}`,
				),
			);
		}
		debugLog(runtime.env, `${url} -> ${String(response.status)} OK`);
		return response;
	});
}