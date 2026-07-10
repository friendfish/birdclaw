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
	requestHybridAnalysisEffect,
	resolveAnalysisModelSettings,
} from "./analysis-runtime";
import { createRuntimeServices } from "./runtime-services";

const originalBirdclawHome = process.env.BIRDCLAW_HOME;
const tempRoots: string[] = [];

beforeEach(() => {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-analysis-runtime-"));
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
		});

		expect(
			parseHybridAnalysis({
				rawText: "Only markdown",
				parse: (value) => value as { title: string },
				fallback: (markdown) => ({ title: markdown }),
			}),
		).toEqual({
			markdown: "Only markdown",
			value: { title: "Only markdown" },
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
});
