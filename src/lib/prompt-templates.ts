import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { getBirdclawPaths } from "./config";

export const PROMPT_TEMPLATE_SCHEMA_VERSION = 1;
export const PROMPT_TEMPLATE_SCHEMA_LINE = "<!-- birdclaw-prompt-schema: 1 -->";
export const PROMPT_SYSTEM_MARKER = "<!-- birdclaw-prompt-system -->";
export const PROMPT_REQUIREMENTS_MARKER =
	"<!-- birdclaw-prompt-requirements -->";

export type PromptFeature =
	| "period-digest"
	| "profile-analysis"
	| "search-discussion";

export interface EditablePrompt {
	system: string;
	requirements: string;
}

export interface PromptProtocol {
	system: string;
	taskInstruction: string;
	requirements: string;
}

export interface PromptTemplateDefinition {
	feature: PromptFeature;
	label: string;
	description: string;
	defaults: EditablePrompt;
	protocol: PromptProtocol;
}

export interface PromptTemplateState extends EditablePrompt {
	feature: PromptFeature;
	isCustom: boolean;
	schemaVersion: number;
	parseError?: string;
}

export interface EffectivePrompt extends EditablePrompt {
	taskInstruction: string;
	promptHash: string;
}

const PERIOD_DIGEST_JSON_SHAPE =
	'- JSON shape: { "title": string, "summary": string, "keyTopics": [{ "title": string, "summary": string, "tweetIds": string[], "handles": string[] }], "notableLinks": [{ "title": string, "url": string, "why": string, "sourceTweetIds": string[] }], "people": [{ "handle": string, "name"?: string, "why": string }], "actionItems": [{ "kind": "reply"|"follow_up"|"read"|"sync", "label": string, "tweetId"?: string, "dmConversationId"?: string }], "sourceTweetIds": string[] }';

const PROFILE_ANALYSIS_JSON_SHAPE =
	'- JSON shape: { "title": string, "summary": string, "voice": string, "themes": [{ "title": string, "summary": string, "tweetIds": string[], "handles": string[] }], "conversationStyle": string, "notableSignals": string[], "risks": string[], "followUps": string[], "sourceTweetIds": string[], "sourceHandles": string[] }';

const SEARCH_DISCUSSION_JSON_SHAPE =
	'- JSON shape: { "title": string, "summary": string, "themes": [{ "title": string, "summary": string, "tweetIds": string[], "dmConversationIds": string[], "handles": string[] }], "tensions": string[], "followUps": string[], "sourceTweetIds": string[], "sourceDmConversationIds": string[] }';

export const PROMPT_TEMPLATE_DEFINITIONS: Record<
	PromptFeature,
	PromptTemplateDefinition
> = {
	"period-digest": {
		feature: "period-digest",
		label: "Today",
		description: "Daily and period summaries from your local archive.",
		defaults: {
			system:
				"You are a precise local Twitter archive analyst. Do not invent events not present in the dataset.",
			requirements: [
				"- Stream one readable Markdown report first. The UI will show this text directly; do not rely on separate cards or structured summaries.",
				"- Target 700-1100 words when there is enough data.",
				"- Start with a 2-3 sentence lead that immediately says what people are talking about.",
				'- Use sections named "What people are talking about", "Important links shared", and "Worth opening". Add "Worth replying to" only if there are clearly high-signal replies. Translate these section titles when a report language is requested.',
				"- When a tweet has replyToTweet, use that parent context to understand what the author was replying to and whether Peter already joined the conversation.",
				"- Use bullets under each section. Each bullet should be specific and explain why it matters.",
				"- Prefer synthesis over chronology. Group repeated chatter into one bullet.",
				"- Mention handles when useful, but do not make the report a list of handles.",
				'- Do not include a generic "Action items" section.',
				"- If there is no data, say that plainly in one short paragraph.",
				"- DMs are private context and only present when explicitly included.",
			].join("\n"),
		},
		protocol: {
			system:
				"Stream Markdown first, then emit the requested JSON object after the delimiter.",
			taskInstruction:
				'Write a high-signal "what happened" report from this local Twitter/X dataset.',
			requirements: [
				"- For tweets: cite every claim with inline tweet ids at the end of the relevant sentence or bullet, e.g. (tweet_123, tweet_456). These citations become hoverable source links.",
				"- For links: emit normal Markdown links with no space between the label and URL, e.g. [title](https://example.com), then cite the sharing tweet ids in the same bullet.",
				"- After the Markdown, output a blank line, then a line containing only three hyphens, then one compact JSON object.",
				'- Keep actionItems empty unless you wrote a "Worth replying to" section.',
				"- Put every tweet id cited in the Markdown into sourceTweetIds.",
				PERIOD_DIGEST_JSON_SHAPE,
			].join("\n"),
		},
	},
	"profile-analysis": {
		feature: "profile-analysis",
		label: "Analyse",
		description: "Profile analysis from locally available account data.",
		defaults: {
			system:
				"You are a precise X/Twitter profile analyst. Use only supplied data.",
			requirements: [
				"- Summarize who this person appears to be, what they care about, and what kind of attention they attract.",
				"- Separate authored profile evidence from conversation/reply evidence.",
				"- Cover recurring topics, tone, technical interests, social graph hints, interaction style, and likely follow-up angles.",
				"- Do not overstate beyond the supplied data.",
				"- If conversation context is sparse, say so.",
				"- Use level 2 (##) and level 3 (###) Markdown headings only. Do not use headings smaller than level 3 (avoid #### or smaller headings).",
			].join("\n"),
		},
		protocol: {
			system: "Return Markdown plus the requested JSON after the delimiter.",
			taskInstruction:
				"Write a high-signal Markdown profile analysis from X/Twitter API data.",
			requirements: [
				"- Cite claims with tweet ids at sentence ends, e.g. (1234567890). Cite handles only when they are in the dataset.",
				"- After Markdown, output a blank line, a line containing only three hyphens, then one compact JSON object.",
				PROFILE_ANALYSIS_JSON_SHAPE,
			].join("\n"),
		},
	},
	"search-discussion": {
		feature: "search-discussion",
		label: "Discuss",
		description: "Discussion synthesis over a local archive search.",
		defaults: {
			system:
				"You are a precise local Twitter archive analyst. Do not invent events not present in the dataset.",
			requirements: [
				"- Start with a concise summary of what the matching posts are really about.",
				'- Then write sections named "Themes", "Discussion", and "Follow-ups".',
				"- Use bullets when grouping multiple points.",
				"- Compare agreement, disagreement, shifts over time, and recurring people or links when visible.",
				"- DMs are private context and only present when explicitly included; do not quote private text at length.",
				"- If there is no data, say that plainly in one short paragraph.",
			].join("\n"),
		},
		protocol: {
			system:
				"Stream Markdown first, then emit the requested JSON object after the delimiter.",
			taskInstruction:
				"Write a high-signal Markdown discussion from this local Twitter/X search result set.",
			requirements: [
				"- Cite claims with tweet ids or DM conversation ids at the end of the sentence, e.g. (tweet_123) or (dm_456).",
				"- After the Markdown, output a blank line, then a line containing only three hyphens, then one compact JSON object.",
				"- Put every cited tweet id in sourceTweetIds and every cited DM conversation id in sourceDmConversationIds.",
				SEARCH_DISCUSSION_JSON_SHAPE,
			].join("\n"),
		},
	},
};

function promptDirectory() {
	return path.join(getBirdclawPaths().rootDir, "prompts");
}

function promptPath(feature: PromptFeature) {
	return path.join(promptDirectory(), `${feature}.md`);
}

function markerCount(content: string, marker: string) {
	return content.split(marker).length - 1;
}

function parseTemplateFile(
	feature: PromptFeature,
	content: string,
): PromptTemplateState {
	const defaults = PROMPT_TEMPLATE_DEFINITIONS[feature].defaults;
	const fail = (parseError: string): PromptTemplateState => ({
		feature,
		...defaults,
		isCustom: true,
		schemaVersion: PROMPT_TEMPLATE_SCHEMA_VERSION,
		parseError,
	});
	const firstLine = content.split(/\r?\n/u, 1)[0];
	if (firstLine !== PROMPT_TEMPLATE_SCHEMA_LINE) {
		return fail("Unsupported or missing prompt template schema version.");
	}
	if (
		markerCount(content, PROMPT_SYSTEM_MARKER) !== 1 ||
		markerCount(content, PROMPT_REQUIREMENTS_MARKER) !== 1
	) {
		return fail("Prompt template markers must each appear exactly once.");
	}
	const systemMarkerIndex = content.indexOf(PROMPT_SYSTEM_MARKER);
	const requirementsMarkerIndex = content.indexOf(PROMPT_REQUIREMENTS_MARKER);
	if (systemMarkerIndex >= requirementsMarkerIndex) {
		return fail("Prompt template markers are out of order.");
	}
	const system = content
		.slice(
			systemMarkerIndex + PROMPT_SYSTEM_MARKER.length,
			requirementsMarkerIndex,
		)
		.trim();
	const requirements = content
		.slice(requirementsMarkerIndex + PROMPT_REQUIREMENTS_MARKER.length)
		.trim();
	if (!system || !requirements) {
		return fail(
			"Prompt template system and requirements sections cannot be empty.",
		);
	}
	return {
		feature,
		system,
		requirements,
		isCustom: true,
		schemaVersion: PROMPT_TEMPLATE_SCHEMA_VERSION,
	};
}

export function readPromptTemplate(
	feature: PromptFeature,
): PromptTemplateState {
	const filePath = promptPath(feature);
	if (!existsSync(filePath)) {
		return {
			feature,
			...PROMPT_TEMPLATE_DEFINITIONS[feature].defaults,
			isCustom: false,
			schemaVersion: PROMPT_TEMPLATE_SCHEMA_VERSION,
		};
	}
	try {
		return parseTemplateFile(feature, readFileSync(filePath, "utf8"));
	} catch (error) {
		return {
			feature,
			...PROMPT_TEMPLATE_DEFINITIONS[feature].defaults,
			isCustom: true,
			schemaVersion: PROMPT_TEMPLATE_SCHEMA_VERSION,
			parseError:
				error instanceof Error
					? error.message
					: "Unable to read prompt template.",
		};
	}
}

function assertEditablePrompt(prompt: EditablePrompt) {
	if (!prompt.system.trim() || !prompt.requirements.trim()) {
		throw new Error("System and requirements content cannot be empty.");
	}
	const reserved = [
		PROMPT_TEMPLATE_SCHEMA_LINE,
		PROMPT_SYSTEM_MARKER,
		PROMPT_REQUIREMENTS_MARKER,
	];
	if (reserved.some((marker) => prompt.system.includes(marker))) {
		throw new Error("System content contains a reserved prompt marker.");
	}
	if (reserved.some((marker) => prompt.requirements.includes(marker))) {
		throw new Error("Requirements content contains a reserved prompt marker.");
	}
}

function serializePromptTemplate(prompt: EditablePrompt) {
	return `${PROMPT_TEMPLATE_SCHEMA_LINE}\n\n${PROMPT_SYSTEM_MARKER}\n${prompt.system.trim()}\n\n${PROMPT_REQUIREMENTS_MARKER}\n${prompt.requirements.trim()}\n`;
}

export function writePromptTemplate(
	feature: PromptFeature,
	prompt: EditablePrompt,
): PromptTemplateState {
	assertEditablePrompt(prompt);
	const directory = promptDirectory();
	mkdirSync(directory, { recursive: true });
	const filePath = promptPath(feature);
	const temporaryPath = path.join(
		directory,
		`.${feature}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporaryPath, serializePromptTemplate(prompt), {
			encoding: "utf8",
			flag: "wx",
		});
		renameSync(temporaryPath, filePath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
	return readPromptTemplate(feature);
}

export function resetPromptTemplate(
	feature: PromptFeature,
): PromptTemplateState {
	rmSync(promptPath(feature), { force: true });
	return readPromptTemplate(feature);
}

export function materializeEffectivePrompt(
	editablePrompt: EditablePrompt,
	protocol: PromptProtocol,
): EffectivePrompt {
	const system = [editablePrompt.system.trim(), protocol.system.trim()]
		.filter(Boolean)
		.join(" ");
	const requirements = [
		editablePrompt.requirements.trim(),
		protocol.requirements.trim(),
	]
		.filter(Boolean)
		.join("\n");
	const taskInstruction = protocol.taskInstruction.trim();
	const promptHash = createHash("sha256")
		.update(JSON.stringify({ system, taskInstruction, requirements }))
		.digest("hex");
	return { system, taskInstruction, requirements, promptHash };
}

export function resolveEffectivePrompt(
	feature: PromptFeature,
	protocol: PromptProtocol = PROMPT_TEMPLATE_DEFINITIONS[feature].protocol,
) {
	const template = readPromptTemplate(feature);
	return materializeEffectivePrompt(template, protocol);
}

export function promptTemplateDefinition(feature: PromptFeature) {
	return PROMPT_TEMPLATE_DEFINITIONS[feature];
}

export const __test__ = {
	parseTemplateFile,
	promptDirectory,
	promptPath,
	serializePromptTemplate,
};
