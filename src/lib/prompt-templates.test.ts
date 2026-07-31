// @vitest-environment node
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import {
	__test__,
	materializeEffectivePrompt,
	PROMPT_REQUIREMENTS_MARKER,
	PROMPT_SYSTEM_MARKER,
	PROMPT_TEMPLATE_DEFINITIONS,
	PROMPT_TEMPLATE_SCHEMA_LINE,
	readPromptTemplate,
	resetPromptTemplate,
	resolveEffectivePrompt,
	writePromptTemplate,
} from "./prompt-templates";

let tempRoot = "";

beforeEach(() => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-prompts-"));
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
});

afterEach(() => {
	delete process.env.BIRDCLAW_HOME;
	resetBirdclawPathsForTests();
});

describe("prompt templates", () => {
	it("returns defaults without writing when no custom file exists", () => {
		const state = readPromptTemplate("period-digest");
		expect(state).toMatchObject({
			...PROMPT_TEMPLATE_DEFINITIONS["period-digest"].defaults,
			isCustom: false,
		});
		expect(existsSync(path.join(tempRoot, "prompts"))).toBe(false);
	});

	it("creates the prompt directory on first save and round trips", () => {
		const saved = writePromptTemplate("search-discussion", {
			system: "Custom system",
			requirements: "- Custom guidance",
		});
		expect(saved).toMatchObject({
			system: "Custom system",
			requirements: "- Custom guidance",
			isCustom: true,
		});
		expect(
			readFileSync(__test__.promptPath("search-discussion"), "utf8"),
		).toContain(PROMPT_REQUIREMENTS_MARKER);
		expect(resetPromptTemplate("search-discussion").isCustom).toBe(false);
	});

	it("falls back visibly when a file is malformed", () => {
		writePromptTemplate("profile-analysis", {
			system: "Custom system",
			requirements: "- Custom guidance",
		});
		writeFileSync(__test__.promptPath("profile-analysis"), "broken", "utf8");
		const state = readPromptTemplate("profile-analysis");
		expect(state.parseError).toBeTruthy();
		expect(state.system).toBe(
			PROMPT_TEMPLATE_DEFINITIONS["profile-analysis"].defaults.system,
		);
	});

	it("reports malformed marker layouts and unreadable template paths", () => {
		const feature = "period-digest";
		expect(
			__test__.parseTemplateFile(
				feature,
				`${PROMPT_TEMPLATE_SCHEMA_LINE}\n${PROMPT_SYSTEM_MARKER}\nSystem\n${PROMPT_SYSTEM_MARKER}\n${PROMPT_REQUIREMENTS_MARKER}\nRequirements`,
			).parseError,
		).toMatch(/exactly once/u);
		expect(
			__test__.parseTemplateFile(
				feature,
				`${PROMPT_TEMPLATE_SCHEMA_LINE}\n${PROMPT_REQUIREMENTS_MARKER}\nRequirements\n${PROMPT_SYSTEM_MARKER}\nSystem`,
			).parseError,
		).toMatch(/out of order/u);
		expect(
			__test__.parseTemplateFile(
				feature,
				`${PROMPT_TEMPLATE_SCHEMA_LINE}\n${PROMPT_SYSTEM_MARKER}\n\n${PROMPT_REQUIREMENTS_MARKER}\nRequirements`,
			).parseError,
		).toMatch(/cannot be empty/u);

		mkdirSync(__test__.promptPath(feature), { recursive: true });
		expect(readPromptTemplate(feature).parseError).toMatch(/directory|EISDIR/u);
	});

	it("rejects reserved markers before writing", () => {
		expect(() =>
			writePromptTemplate("period-digest", {
				system: `Explain ${PROMPT_SYSTEM_MARKER}`,
				requirements: "- Fine",
			}),
		).toThrow(/reserved prompt marker/u);
		expect(() =>
			writePromptTemplate("period-digest", {
				system: "System",
				requirements: `Explain ${PROMPT_REQUIREMENTS_MARKER}`,
			}),
		).toThrow(/reserved prompt marker/u);
		expect(() =>
			writePromptTemplate("period-digest", {
				system: " ",
				requirements: "Requirements",
			}),
		).toThrow(/cannot be empty/u);
	});

	it("hashes materialized protocol content but ignores source metadata", () => {
		const editable = { system: "System", requirements: "Guidance" };
		const first = materializeEffectivePrompt(editable, {
			system: "Protocol A",
			taskInstruction: "Task A",
			requirements: "Shape A",
		});
		const second = materializeEffectivePrompt(editable, {
			system: "Protocol B",
			taskInstruction: "Task B",
			requirements: "Shape A",
		});
		expect(first.taskInstruction).toBe("Task A");
		expect(first.promptHash).not.toBe(second.promptHash);
		writePromptTemplate("period-digest", {
			...PROMPT_TEMPLATE_DEFINITIONS["period-digest"].defaults,
		});
		expect(resolveEffectivePrompt("period-digest").promptHash).toBe(
			materializeEffectivePrompt(
				PROMPT_TEMPLATE_DEFINITIONS["period-digest"].defaults,
				PROMPT_TEMPLATE_DEFINITIONS["period-digest"].protocol,
			).promptHash,
		);
	});

	it("materializes the same locked protocol for saved and playground drafts", () => {
		const definition = PROMPT_TEMPLATE_DEFINITIONS["search-discussion"];
		writePromptTemplate("search-discussion", {
			system: "Saved system",
			requirements: "Saved requirements",
		});
		const saved = resolveEffectivePrompt("search-discussion");
		const playground = materializeEffectivePrompt(
			{
				system: "Playground system",
				requirements: "Playground requirements",
			},
			definition.protocol,
		);

		expect(saved.system).toBe(`Saved system ${definition.protocol.system}`);
		expect(playground.system).toBe(
			`Playground system ${definition.protocol.system}`,
		);
		expect(saved.requirements).toBe(
			`Saved requirements\n${definition.protocol.requirements}`,
		);
		expect(playground.requirements).toBe(
			`Playground requirements\n${definition.protocol.requirements}`,
		);
	});
});
