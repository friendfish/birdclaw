// @vitest-environment node
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createOpenAIStreamState,
	debugLog,
	isOpenAIStreamDiagnostics,
	openAIStreamDiagnosticsFromError,
	OpenAIStreamError,
	processOpenAIResponseSseChunk,
	readOpenAIResponseStreamEffect,
	requestOpenAIResponseEffect,
	resolveOpenAIBaseUrl,
	sanitizeOpenAIStreamDiagnostics,
} from "./openai-response-runtime";

const originalBirdclawHome = process.env.BIRDCLAW_HOME;
const tempRoots: string[] = [];

beforeEach(() => {
	const tempRoot = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-openai-runtime-"),
	);
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	delete process.env.OPENAI_API_KEY;
	delete process.env.BIRDCLAW_AI_MODEL;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (originalBirdclawHome !== undefined) {
		process.env.BIRDCLAW_HOME = originalBirdclawHome;
	} else {
		delete process.env.BIRDCLAW_HOME;
	}
	resetBirdclawPathsForTests();
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("resolveOpenAIBaseUrl", () => {
	it("defaults to the OpenAI endpoint", () => {
		expect(resolveOpenAIBaseUrl(() => undefined)).toBe(
			"https://api.openai.com/v1",
		);
	});

	it("uses the birdclaw override and trims trailing slashes", () => {
		const env: Record<string, string> = {
			BIRDCLAW_OPENAI_BASE_URL: "http://localhost:11434/v1/",
		};
		expect(resolveOpenAIBaseUrl((name) => env[name])).toBe(
			"http://localhost:11434/v1",
		);
	});

	it("retains OPENAI_BASE_URL as a compatibility fallback", () => {
		const env: Record<string, string> = {
			OPENAI_BASE_URL: "http://localhost:1234/v1",
		};
		expect(resolveOpenAIBaseUrl((name) => env[name])).toBe(
			"http://localhost:1234/v1",
		);
	});
});

async function readStreamEvents(events: unknown[]) {
	const stream = new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(
					new TextEncoder().encode(
						`data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`,
					),
				);
			}
			controller.close();
		},
	});
	return Effect.runPromiseExit(
		readOpenAIResponseStreamEffect(new Response(stream)),
	);
}

async function expectStreamError(events: unknown[]) {
	const exit = await readStreamEvents(events);
	expect(Exit.isFailure(exit)).toBe(true);
	if (!Exit.isFailure(exit))
		throw new Error("Expected the OpenAI stream to fail");
	const error = Option.getOrUndefined(Cause.failureOption(exit.cause));
	if (!(error instanceof OpenAIStreamError))
		throw new Error("Expected an OpenAIStreamError");
	expect(error).toBeInstanceOf(OpenAIStreamError);
	expect(
		isOpenAIStreamDiagnostics(openAIStreamDiagnosticsFromError(error)),
	).toBe(true);
	return error;
}

describe("OpenAI response runtime", () => {
	it("projects valid diagnostics onto the canonical persistence whitelist", () => {
		const input = {
			responseId: "resp_safe",
			finishReason: "stop",
			visibleTextLength: 42,
			reasoningTextLength: 7,
			rawText: "must not persist",
			prompt: "must not persist",
			usage: { output_tokens: 49 },
		};

		const diagnostics = sanitizeOpenAIStreamDiagnostics(input);

		expect(diagnostics).toEqual({
			responseId: "resp_safe",
			finishReason: "stop",
			visibleTextLength: 42,
			reasoningTextLength: 7,
		});
		expect(diagnostics).not.toBe(input);
		expect(
			sanitizeOpenAIStreamDiagnostics({
				visibleTextLength: Number.POSITIVE_INFINITY,
				reasoningTextLength: 0,
			}),
		).toBeUndefined();
		expect(
			sanitizeOpenAIStreamDiagnostics({
				visibleTextLength: 1,
				reasoningTextLength: -1,
			}),
		).toBeUndefined();
	});

	it("streams visible markdown while retaining hybrid output and metadata", async () => {
		const visible: string[] = [];
		const stream = new ReadableStream({
			start(controller) {
				for (const event of [
					{ type: "response.output_text.delta", delta: "Hello\n-" },
					{ type: "response.output_text.delta", delta: '--\n{"ok":true}' },
					{
						type: "response.completed",
						response: { id: "resp_1", usage: { output_tokens: 2 } },
					},
				]) {
					controller.enqueue(
						new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
					);
				}
				controller.close();
			},
		});
		const result = await Effect.runPromise(
			readOpenAIResponseStreamEffect(new Response(stream), {
				onDelta: (delta) => visible.push(delta),
			}),
		);

		expect(visible.join("")).toBe("Hello");
		expect(result).toEqual({
			rawText: 'Hello\n---\n{"ok":true}',
			responseId: "resp_1",
			usage: { output_tokens: 2 },
			diagnostics: {
				responseId: "resp_1",
				visibleTextLength: 5,
				reasoningTextLength: 0,
			},
		});
	});

	it("rejects hybrid JSON with no pre-delimiter visible text", async () => {
		const error = await expectStreamError([
			{
				type: "response.output_text.delta",
				delta: '\n---\n{"ok":true}',
			},
		]);
		expect(openAIStreamDiagnosticsFromError(error)).toEqual({
			visibleTextLength: 0,
			reasoningTextLength: 0,
		});
	});

	it("rejects a [DONE]-only stream with structured blank-output diagnostics", async () => {
		const error = await expectStreamError(["[DONE]"]);
		expect(openAIStreamDiagnosticsFromError(error)).toEqual({
			visibleTextLength: 0,
			reasoningTextLength: 0,
		});
	});

	it("rejects whitespace-only response output with its visible length", async () => {
		const error = await expectStreamError([
			{ type: "response.output_text.delta", delta: "  \n\t" },
		]);
		expect(openAIStreamDiagnosticsFromError(error)).toEqual({
			visibleTextLength: 4,
			reasoningTextLength: 0,
		});
	});

	it("rejects reasoning-only Chat Completions output with diagnostics", async () => {
		const event = {
			id: "chat_reasoning",
			choices: [
				{
					delta: { reasoning_content: "thinking", reasoning: "analysis" },
					finish_reason: "stop",
				},
			],
		};
		const state = createOpenAIStreamState();
		processOpenAIResponseSseChunk(state, `data: ${JSON.stringify(event)}\n\n`);
		expect(state.rawText).toBe("");
		expect(state.reasoningTextLength).toBe(16);

		const error = await expectStreamError([event]);
		expect(openAIStreamDiagnosticsFromError(error)).toEqual({
			responseId: "chat_reasoning",
			finishReason: "stop",
			visibleTextLength: 0,
			reasoningTextLength: 16,
		});
	});

	it("retains explicit stream error messages at EOF", async () => {
		const error = await expectStreamError([
			{
				type: "response.error",
				error: { message: "quota exceeded" },
			},
		]);
		expect(error.message).toContain("quota exceeded");
	});

	it("retains top-level stream error messages without leaking the event", async () => {
		const rawText = "raw event content must not enter diagnostics";
		const error = await expectStreamError([
			{
				type: "error",
				message: "quota exceeded",
				code: "insufficient_quota",
				rawText,
			},
		]);

		expect(error.message).toContain("quota exceeded");
		expect(error.diagnostics).toEqual({
			visibleTextLength: 0,
			reasoningTextLength: 0,
		});
		expect(JSON.stringify(error.diagnostics)).not.toContain(rawText);
	});

	it("reads chunked CRLF SSE frames", async () => {
		const payload = `data: ${JSON.stringify({
			type: "response.output_text.delta",
			delta: "CRLF",
		})}\r\n\r\ndata: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_crlf" },
		})}\r\n\r\n`;
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(payload.slice(0, 7)));
				controller.enqueue(new TextEncoder().encode(payload.slice(7, -3)));
				controller.enqueue(new TextEncoder().encode(payload.slice(-3)));
				controller.close();
			},
		});
		const visible: string[] = [];
		const result = await Effect.runPromise(
			readOpenAIResponseStreamEffect(new Response(stream), {
				onDelta: (delta) => visible.push(delta),
			}),
		);

		expect(visible).toEqual(["CRLF"]);
		expect(result).toEqual({
			rawText: "CRLF",
			responseId: "resp_crlf",
			diagnostics: {
				responseId: "resp_crlf",
				visibleTextLength: 4,
				reasoningTextLength: 0,
			},
		});
	});

	it("rejects a Chat Completions length terminal without visible output", async () => {
		const error = await expectStreamError([
			{
				id: "chat_length",
				choices: [{ finish_reason: "length" }],
			},
		]);
		expect(openAIStreamDiagnosticsFromError(error)).toEqual({
			responseId: "chat_length",
			finishReason: "length",
			visibleTextLength: 0,
			reasoningTextLength: 0,
		});
	});

	it("retains incomplete SSE frames and ignores malformed events", () => {
		const state = createOpenAIStreamState();
		processOpenAIResponseSseChunk(state, "data: {bad}\n\n");
		processOpenAIResponseSseChunk(
			state,
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "ok",
			})}`,
		);
		expect(state.rawText).toBe("");
		processOpenAIResponseSseChunk(state, "\n\n");
		expect(state.rawText).toBe("ok");
	});

	it("normalizes Chat Completions events without inventing response IDs", () => {
		const state = createOpenAIStreamState();
		processOpenAIResponseSseChunk(
			state,
			`data: ${JSON.stringify({
				choices: [{ delta: { content: "Hello" } }],
			})}\n\n`,
		);
		processOpenAIResponseSseChunk(
			state,
			`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`,
		);
		processOpenAIResponseSseChunk(
			state,
			`data: ${JSON.stringify({
				id: "chat_1",
				choices: [{ finish_reason: "stop" }],
				usage: { completion_tokens: 1 },
			})}\n\n`,
		);

		expect(state.rawText).toBe("Hello");
		expect(state.responseId).toBe("chat_1");
		expect(state.usage).toEqual({ completion_tokens: 1 });
		expect(state.finishReason).toBe("stop");

		const noId = createOpenAIStreamState();
		processOpenAIResponseSseChunk(
			noId,
			`data: ${JSON.stringify({
				choices: [],
				usage: { completion_tokens: 0 },
			})}\n\n`,
		);
		expect(noId.responseId).toBeUndefined();
		expect(noId.usage).toEqual({ completion_tokens: 0 });
	});

	it("captures explicit, incomplete, and generic stream errors", () => {
		const explicit = createOpenAIStreamState();
		processOpenAIResponseSseChunk(
			explicit,
			`data: ${JSON.stringify({
				type: "response.error",
				error: { message: "quota exceeded" },
			})}\n\n`,
		);
		expect(explicit.error).toBe("quota exceeded");

		const incomplete = createOpenAIStreamState();
		processOpenAIResponseSseChunk(
			incomplete,
			`data: ${JSON.stringify({
				type: "response.incomplete",
				response: { incomplete_details: { reason: "max_output_tokens" } },
			})}\n\n`,
		);
		expect(incomplete.error).toBe(
			"OpenAI response incomplete: max_output_tokens",
		);

		const generic = createOpenAIStreamState();
		processOpenAIResponseSseChunk(
			generic,
			`data: ${JSON.stringify({ type: "error", error: "unknown" })}\n\n`,
		);
		expect(generic.error).toBe("OpenAI stream failed");
	});

	it("handles fallback event shapes and suppresses deltas after the delimiter", () => {
		const state = createOpenAIStreamState();
		for (const event of [
			{},
			{ type: "response.completed", response: { id: 42 } },
			{ type: "response.failed", response: "invalid" },
			{ choices: [] },
			{ choices: [{ finish_reason: "stop" }] },
		]) {
			processOpenAIResponseSseChunk(
				state,
				`data: ${JSON.stringify(event)}\n\n`,
			);
		}
		expect(state.responseId).toBeUndefined();
		expect(state.error).toBe("OpenAI stream failed");

		const delimited = createOpenAIStreamState();
		processOpenAIResponseSseChunk(
			delimited,
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: '\n---\n{"ok":true}',
			})}\n\n`,
		);
		processOpenAIResponseSseChunk(
			delimited,
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "ignored",
			})}\n\n`,
		);
		expect(delimited.jsonMode).toBe(true);
		expect(delimited.rawText).toBe('\n---\n{"ok":true}ignored');
	});

	it("writes debug output only when explicitly enabled", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		debugLog(() => undefined, "hidden");
		debugLog((name) => (name === "BIRDCLAW_DEBUG" ? "1" : undefined), "shown");

		expect(write).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledWith("[birdclaw:openai] shown\n");
	});

	it("rejects missing streams and flushes short visible output", async () => {
		await expect(
			Effect.runPromise(readOpenAIResponseStreamEffect(new Response(null))),
		).rejects.toThrow("did not include a stream");

		const visible: string[] = [];
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						`data: ${JSON.stringify({
							type: "response.output_text.delta",
							delta: "short",
						})}\n\n`,
					),
				);
				controller.close();
			},
		});
		const result = await Effect.runPromise(
			readOpenAIResponseStreamEffect(new Response(stream), {
				onDelta: (delta) => visible.push(delta),
			}),
		);

		expect(visible).toEqual(["short"]);
		expect(result).toEqual({
			rawText: "short",
			diagnostics: { visibleTextLength: 5, reasoningTextLength: 0 },
		});
	});

	it("checks credentials and HTTP failures centrally", async () => {
		await expect(
			Effect.runPromise(requestOpenAIResponseEffect({ body: {} })),
		).rejects.toThrow("OPENAI_API_KEY");

		process.env.OPENAI_API_KEY = "test";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })),
		);
		await expect(
			Effect.runPromise(requestOpenAIResponseEffect({ body: {} })),
		).rejects.toThrow("400 bad request");
	});

	it("targets the configured base URL", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const runtime = {
			fetch: fetchMock,
			now: () => new Date(),
			random: () => 0,
			env: (name: string) =>
				({
					OPENAI_API_KEY: "test",
					BIRDCLAW_OPENAI_BASE_URL: "http://localhost:11434/v1",
					BIRDCLAW_OPENAI_API_TYPE: "responses",
				})[name],
		};
		await Effect.runPromise(
			requestOpenAIResponseEffect({ body: { ok: true }, runtime }),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:11434/v1/responses",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("adapts custom endpoints to the Chat Completions request shape", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const runtime = {
			fetch: fetchMock,
			now: () => new Date(),
			random: () => 0,
			env: (name: string) =>
				({
					OPENAI_API_KEY: "test",
					BIRDCLAW_OPENAI_BASE_URL: "https://example.test/v1",
				})[name],
		};
		await Effect.runPromise(
			requestOpenAIResponseEffect({
				body: {
					input: [{ role: "user", content: "Hello" }],
					max_output_tokens: 64,
					reasoning: { effort: "medium" },
					store: true,
					service_tier: "auto",
					temperature: 0.2,
				},
				runtime,
			}),
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://example.test/v1/chat/completions");
		expect(JSON.parse(String(init.body))).toEqual({
			messages: [{ role: "user", content: "Hello" }],
			max_tokens: 64,
			temperature: 0.2,
		});
	});

	it("supports explicit Chat Completions mode on the OpenAI endpoint", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 200 }));
		const runtime = {
			fetch: fetchMock,
			now: () => new Date(),
			random: () => 0,
			env: (name: string) =>
				({
					OPENAI_API_KEY: "test",
					BIRDCLAW_OPENAI_API_TYPE: "chat",
				})[name],
		};
		await Effect.runPromise(
			requestOpenAIResponseEffect({ body: { temperature: 0 }, runtime }),
		);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.openai.com/v1/chat/completions");
		expect(JSON.parse(String(init.body))).toEqual({
			temperature: 0,
			messages: [],
		});
	});

	it("normalizes non-Error network failures", async () => {
		const runtime = {
			fetch: vi.fn().mockRejectedValue("offline"),
			now: () => new Date(),
			random: () => 0,
			env: (name: string) => (name === "OPENAI_API_KEY" ? "test" : undefined),
		};

		await expect(
			Effect.runPromise(requestOpenAIResponseEffect({ body: {}, runtime })),
		).rejects.toThrow("offline");
	});
});
