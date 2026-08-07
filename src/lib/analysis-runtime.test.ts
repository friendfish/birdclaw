// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createAnalysisRequestBody,
	parseHybridAnalysis,
	readHybridAnalysisStreamEffect,
	requestHybridAnalysisEffect,
	resolveAnalysisModelSettings,
} from "./analysis-runtime";
import { createRuntimeServices } from "./runtime-services";

const originalBirdclawHome = process.env.BIRDCLAW_HOME;
const tempRoots: string[] = [];

beforeEach(() => {
	const tempRoot = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-analysis-runtime-"),
	);
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	delete process.env.OPENAI_API_KEY;
	delete process.env.BIRDCLAW_AI_MODEL;
	delete process.env.BIRDCLAW_OPENAI_REASONING_EFFORT;
	delete process.env.BIRDCLAW_OPENAI_SERVICE_TIER;
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

describe("analysis runtime", () => {
	it("resolves shared model settings and request bodies", () => {
		const settings = resolveAnalysisModelSettings(
			{
				reasoningEffort: "high",
			},
			createRuntimeServices({
				env: (name) => (name === "BIRDCLAW_AI_MODEL" ? "env-model" : undefined),
			}),
		);
		expect(settings).toEqual({
			model: "env-model",
			reasoningEffort: "high",
			serviceTier: "priority",
		});
		expect(
			createAnalysisRequestBody({
				settings,
				system: "system",
				prompt: "prompt",
				stream: true,
			}),
		).toMatchObject({
			model: "env-model",
			reasoning: { effort: "high" },
			service_tier: "priority",
			stream: true,
		});
	});

	it("parses structured output and falls back to markdown", () => {
		const parsed = parseHybridAnalysis({
			rawText: 'Summary\n---\n{"title":"ok"}',
			parse: (value) => value as { title: string },
			fallback: () => ({ title: "fallback" }),
		});
		expect(parsed).toEqual({
			markdown: "Summary",
			value: { title: "ok" },
			parseStatus: "structured",
		});

		expect(
			parseHybridAnalysis({
				rawText: "Only markdown",
				parse: (value) => value as { title: string },
				fallback: (markdown) => ({ title: markdown }),
			}),
		).toMatchObject({
			markdown: "Only markdown",
			value: { title: "Only markdown" },
			parseStatus: "fallback",
		});
	});

	it("handles non-stream response extraction centrally", async () => {
		const runtime = createRuntimeServices({
			env: (name) => (name === "OPENAI_API_KEY" ? "test" : undefined),
			fetch: vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						output: [{ content: [{ text: 'Profile\n---\n{"title":"ok"}' }] }],
					}),
					{ status: 200 },
				),
			),
		});

		await expect(
			Effect.runPromise(
				requestHybridAnalysisEffect({
					body: {},
					runtime,
					parse: (value) => value as { title: string },
					fallback: () => ({ title: "fallback" }),
				}),
			),
		).resolves.toMatchObject({
			markdown: "Profile",
			value: { title: "ok" },
		});
	});

	it("propagates successful Chat stream diagnostics", async () => {
		const stream = new ReadableStream({
			start(controller) {
				for (const event of [
					{
						id: "chat_1",
						choices: [{ delta: { content: "Summary" }, finish_reason: null }],
					},
					{
						id: "chat_1",
						choices: [{ delta: {}, finish_reason: "stop" }],
					},
					"[DONE]",
				]) {
					controller.enqueue(
						new TextEncoder().encode(
							`data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`,
						),
					);
				}
				controller.close();
			},
		});

		const result = await Effect.runPromise(
			readHybridAnalysisStreamEffect(new Response(stream), {
				parse: (value) => value as { title: string },
				fallback: (markdown) => ({ title: markdown }),
			}),
		);

		expect(result.diagnostics).toEqual({
			responseId: "chat_1",
			finishReason: "stop",
			visibleTextLength: 7,
			reasoningTextLength: 0,
		});
	});

	it("rejects whitespace-only non-stream response output", async () => {
		const runtime = createRuntimeServices({
			env: (name) => (name === "OPENAI_API_KEY" ? "test" : undefined),
			fetch: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ output_text: " \n\t " }), {
					status: 200,
				}),
			),
		});

		await expect(
			Effect.runPromise(
				requestHybridAnalysisEffect({
					body: {},
					runtime,
					parse: (value) => value as { title: string },
					fallback: () => ({ title: "fallback" }),
				}),
			),
		).rejects.toThrow("OpenAI returned no output text");
	});
});
