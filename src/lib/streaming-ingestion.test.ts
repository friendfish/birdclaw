import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runEffectPromise } from "./effect-runtime";
import {
	collectIngestionSourcesEffect,
	ingestStreamInBatchesEffect,
	ingestSourcesInBatchesEffect,
	streamAssignedJsonArray,
	streamJsonLines,
} from "./streaming-ingestion";

async function collect<T>(source: AsyncIterable<T>) {
	const values: T[] = [];
	for await (const value of source) values.push(value);
	return values;
}

describe("streaming ingestion", () => {
	it("preserves unicode separators in physical JSONL records", async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "birdclaw-jsonl-"));
		const filePath = path.join(directory, "legacy.jsonl");
		const first = {
			text: `${"x".repeat(65_526)}\u2028line\u2029paragraph`,
		};
		const second = { text: "final record" };
		try {
			writeFileSync(
				filePath,
				`${JSON.stringify(first)}\r\n\n${JSON.stringify(second)}`,
			);

			await expect(collect(streamJsonLines(filePath))).resolves.toEqual([
				{ lineNumber: 1, value: first },
				{ lineNumber: 3, value: second },
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("parses assigned JSON arrays across chunk boundaries", async () => {
		const source = Readable.from([
			'window.YTD.tweets.part0 = [{"tweet":{"id":"1",',
			'"text":"comma, bracket ]"}},',
			'{"tweet":{"id":"2","text":"escaped \\"quote\\""}}];',
		]);

		await expect(collect(streamAssignedJsonArray(source))).resolves.toEqual([
			{ tweet: { id: "1", text: "comma, bracket ]" } },
			{ tweet: { id: "2", text: 'escaped "quote"' } },
		]);
	});

	it("batches records and resumes after a checkpoint", async () => {
		const processBatch = vi.fn();
		const checkpoints: number[] = [];
		const result = await runEffectPromise(
			ingestStreamInBatchesEffect({
				batchSize: 2,
				resumeAfter: 2,
				source: async function* () {
					for (const value of [1, 2, 3, 4, 5]) yield value;
				},
				processBatch,
				onCheckpoint: ({ processed }) => {
					checkpoints.push(processed);
				},
			}),
		);

		expect(processBatch).toHaveBeenNthCalledWith(1, [3, 4], { processed: 4 });
		expect(processBatch).toHaveBeenNthCalledWith(2, [5], { processed: 5 });
		expect(checkpoints).toEqual([4, 5]);
		expect(result).toEqual({ processed: 5 });
	});

	it("ingests named sources sequentially with aggregate checkpoints", async () => {
		const batches: Array<{
			values: number[];
			processed: number;
			source: string;
		}> = [];
		const completed: string[] = [];
		const result = await runEffectPromise(
			ingestSourcesInBatchesEffect({
				batchSize: 2,
				sources: [
					{
						id: "first",
						stream: async function* () {
							yield 1;
							yield 2;
							yield 3;
						},
					},
					{
						id: "second",
						stream: async function* () {
							yield 4;
						},
					},
				],
				processBatch: (values, checkpoint) => {
					batches.push({
						values,
						processed: checkpoint.processed,
						source: checkpoint.sourceId,
					});
				},
				onSourceComplete: ({ sourceId }) => {
					completed.push(sourceId);
				},
			}),
		);

		expect(batches).toEqual([
			{ values: [1, 2], processed: 2, source: "first" },
			{ values: [3], processed: 3, source: "first" },
			{ values: [4], processed: 4, source: "second" },
		]);
		expect(completed).toEqual(["first", "second"]);
		expect(result).toEqual({ processed: 4 });
	});

	it("collects records from multiple sources in source order", async () => {
		const effect = collectIngestionSourcesEffect([
			{
				id: "a",
				stream: async function* () {
					yield "a1";
					yield "a2";
				},
			},
			{
				id: "b",
				stream: async function* () {
					yield "b1";
				},
			},
		]);
		const rows = await runEffectPromise(effect);

		expect(rows).toEqual(["a1", "a2", "b1"]);
		await expect(runEffectPromise(effect)).resolves.toEqual(["a1", "a2", "b1"]);
	});
});
