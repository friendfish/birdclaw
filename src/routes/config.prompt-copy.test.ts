// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("prompt configuration copy", () => {
	it("keeps prompt-specific controls and warnings in English", () => {
		const source = readFileSync(
			new URL("./config.tsx", import.meta.url),
			"utf8",
		);

		expect(source).toContain("Advanced mode");
		expect(source).toContain("Running...");
		expect(source).toContain(
			"Changing a template invalidates matching AI caches",
		);
		expect(source).not.toMatch(/高阶模式|运行中|模板内容变化后/);
	});
});
