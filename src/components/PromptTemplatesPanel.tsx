import { useEffect, useRef, useState } from "react";
import {
	AlertCircle,
	CheckCircle,
	Play,
	RotateCcw,
	Save,
	ShieldCheck,
	Square,
} from "lucide-react";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { fetchJson } from "#/lib/api-client";
import { consumeNdjson } from "#/lib/client-ndjson";
import type { PlaygroundResultBase } from "#/lib/prompt-playground";
import {
	periodDigestPlaygroundStreamEventSchema,
	profileAnalysisPlaygroundResponseSchema,
	promptTemplateResponseSchema,
	searchDiscussionPlaygroundStreamEventSchema,
	type PromptTemplateResponse,
} from "#/lib/prompt-playground-contracts";
import type { PromptFeature } from "#/lib/prompt-templates";
import {
	cx,
	primaryButtonClass,
	selectFieldClass,
	secondaryButtonClass,
	textFieldClass,
} from "#/lib/ui";

const PROMPT_FEATURES: Array<{ value: PromptFeature; label: string }> = [
	{ value: "period-digest", label: "Today" },
	{ value: "profile-analysis", label: "Analyse" },
	{ value: "search-discussion", label: "Discuss" },
];

type PlaygroundViewResult = PlaygroundResultBase;

interface ActivePromptRun {
	id: symbol;
	feature: PromptFeature;
	controller: AbortController;
}

function AdvancedPromptPreview({
	feature,
	protocol,
	section,
}: {
	feature: PromptFeature;
	protocol: { system: string; taskInstruction: string; requirements: string };
	section: "system" | "header" | "requirements";
}) {
	const header =
		feature === "period-digest"
			? "Window / time range / content scope / source counts"
			: feature === "profile-analysis"
				? "Profile / account cache / local tweet and conversation counts"
				: "Search query / source / local search status / source counts";
	const languagePlaceholder =
		feature === "period-digest"
			? "\n<dynamic language instructions when configured>"
			: feature === "profile-analysis"
				? "<dynamic Simplified Chinese suffix when configured>"
				: "";
	const content =
		section === "system"
			? protocol.system
			: section === "header"
				? `<${header}>\n\n${protocol.taskInstruction}\n\nRequirements:`
				: `${protocol.requirements}${languagePlaceholder}\n\nDataset:\n<local data selected below>`;
	return (
		<div className="rounded-md border border-[var(--line)] bg-[var(--bg-active)] p-3 font-mono text-[12px] leading-5 text-[var(--ink-soft)] whitespace-pre-wrap">
			{content}
		</div>
	);
}

export function PromptTemplatesPanel({ aiLanguage }: { aiLanguage: string }) {
	const [feature, setFeature] = useState<PromptFeature>("period-digest");
	const [template, setTemplate] = useState<PromptTemplateResponse | null>(null);
	const [system, setSystem] = useState("");
	const [requirements, setRequirements] = useState("");
	const [advanced, setAdvanced] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [running, setRunning] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [promptError, setPromptError] = useState<string | null>(null);
	const [result, setResult] = useState<PlaygroundViewResult | null>(null);
	const [streamedMarkdown, setStreamedMarkdown] = useState("");
	const [period, setPeriod] = useState<"today" | "24h" | "yesterday" | "week">(
		"today",
	);
	const [contentSource, setContentSource] = useState<
		"all" | "for_you" | "following"
	>("all");
	const [profileHandle, setProfileHandle] = useState("");
	const [profileOptions, setProfileOptions] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const activeRunRef = useRef<ActivePromptRun | null>(null);

	useEffect(
		() => () => {
			const activeRun = activeRunRef.current;
			activeRunRef.current = null;
			activeRun?.controller.abort();
		},
		[],
	);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setPromptError(null);
		setMessage(null);
		setResult(null);
		setStreamedMarkdown("");
		void fetchJson(
			`/api/prompt-templates?feature=${encodeURIComponent(feature)}`,
			undefined,
			promptTemplateResponseSchema,
			"Failed to load prompt template",
		)
			.then((response) => {
				if (cancelled) return;
				setTemplate(response);
				setSystem(response.template.system);
				setRequirements(response.template.requirements);
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setPromptError(
						error instanceof Error ? error.message : "Failed to load template",
					);
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [feature]);

	useEffect(() => {
		void fetch("/api/profile-analysis-metadata")
			.then((response) => response.json())
			.then((data: unknown) => {
				if (!data || typeof data !== "object") return;
				const record = data as {
					following?: Array<{ handle?: unknown }>;
					analyzed?: Array<{ handle?: unknown }>;
				};
				const handles = [
					...(record.analyzed ?? []),
					...(record.following ?? []),
				]
					.map((item) =>
						typeof item.handle === "string"
							? item.handle.replace(/^@/, "")
							: "",
					)
					.filter(Boolean);
				setProfileOptions([...new Set(handles)]);
				setProfileHandle((current) => current || handles[0] || "");
			})
			.catch(() => undefined);
	}, []);

	const applyTemplateResponse = (response: PromptTemplateResponse) => {
		setTemplate(response);
		setSystem(response.template.system);
		setRequirements(response.template.requirements);
	};

	const stopActiveRun = () => {
		const activeRun = activeRunRef.current;
		activeRunRef.current = null;
		activeRun?.controller.abort();
		setRunning(false);
	};

	const selectFeature = (nextFeature: PromptFeature) => {
		if (nextFeature === feature) return;
		stopActiveRun();
		setFeature(nextFeature);
	};

	const saveTemplate = async () => {
		if (
			template?.template.parseError &&
			!window.confirm(
				"The template file could not be parsed. Saving will replace its original contents with this draft. Continue?",
			)
		) {
			return;
		}
		setSaving(true);
		setPromptError(null);
		setMessage(null);
		try {
			const response = await fetchJson(
				"/api/prompt-templates",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ feature, system, requirements }),
				},
				promptTemplateResponseSchema,
				"Failed to save prompt template",
			);
			applyTemplateResponse(response);
			setMessage("Template saved.");
		} catch (error) {
			setPromptError(error instanceof Error ? error.message : "Save failed");
		} finally {
			setSaving(false);
		}
	};

	const resetTemplate = async () => {
		if (
			!window.confirm("Delete this custom template and restore the default?")
		) {
			return;
		}
		setSaving(true);
		setPromptError(null);
		setMessage(null);
		try {
			const response = await fetchJson(
				"/api/prompt-templates/reset",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ feature }),
				},
				promptTemplateResponseSchema,
				"Failed to restore default prompt",
			);
			applyTemplateResponse(response);
			setMessage("Default template restored.");
		} catch (error) {
			setPromptError(error instanceof Error ? error.message : "Reset failed");
		} finally {
			setSaving(false);
		}
	};

	const runPlayground = async () => {
		const abortController = new AbortController();
		const run: ActivePromptRun = {
			id: Symbol("prompt-playground-run"),
			feature,
			controller: abortController,
		};
		activeRunRef.current?.controller.abort();
		activeRunRef.current = run;
		const isActiveRun = () => activeRunRef.current?.id === run.id;
		setRunning(true);
		setPromptError(null);
		setMessage(null);
		setResult(null);
		setStreamedMarkdown("");
		try {
			if (run.feature === "profile-analysis") {
				const response = await fetchJson(
					"/api/prompt-playground/profile-analysis",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							handle: profileHandle,
							language: aiLanguage,
							system,
							requirements,
						}),
						signal: abortController.signal,
					},
					profileAnalysisPlaygroundResponseSchema,
					"Analyse playground failed",
				);
				if (isActiveRun()) {
					setResult(response.result);
					setStreamedMarkdown(response.result.markdown);
				}
				return;
			}

			const isToday = run.feature === "period-digest";
			const response = await fetch(
				isToday
					? "/api/prompt-playground/period-digest"
					: "/api/prompt-playground/search-discussion",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(
						isToday
							? {
									period,
									contentSource,
									language: aiLanguage,
									system,
									requirements,
								}
							: {
									query,
									source: "search",
									system,
									requirements,
								},
					),
					signal: abortController.signal,
				},
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as {
					message?: string;
				} | null;
				throw new Error(body?.message || "Playground request failed");
			}
			if (!response.body) throw new Error("Playground stream was unavailable");
			if (isToday) {
				await consumeNdjson({
					body: response.body,
					schema: periodDigestPlaygroundStreamEventSchema,
					signal: abortController.signal,
					onEvent: (event) => {
						if (!isActiveRun()) return;
						if (event.type === "delta") {
							setStreamedMarkdown((current) => current + event.delta);
						} else if (event.type === "done") {
							setResult(event.result);
							setStreamedMarkdown(event.result.markdown);
						} else {
							setPromptError(event.error);
						}
					},
					isTerminal: (event) =>
						event.type === "done" || event.type === "error",
				});
			} else {
				await consumeNdjson({
					body: response.body,
					schema: searchDiscussionPlaygroundStreamEventSchema,
					signal: abortController.signal,
					onEvent: (event) => {
						if (!isActiveRun()) return;
						if (event.type === "delta") {
							setStreamedMarkdown((current) => current + event.delta);
						} else if (event.type === "done") {
							setResult(event.result);
							setStreamedMarkdown(event.result.markdown);
						} else {
							setPromptError(event.error);
						}
					},
					isTerminal: (event) =>
						event.type === "done" || event.type === "error",
				});
			}
		} catch (error) {
			if (isActiveRun() && !abortController.signal.aborted) {
				setPromptError(error instanceof Error ? error.message : "Run failed");
			}
		} finally {
			if (isActiveRun()) {
				activeRunRef.current = null;
				setRunning(false);
			}
		}
	};

	if (loading) {
		return (
			<div className="py-10 text-center text-[14px] text-[var(--ink-soft)]">
				Loading prompt template...
			</div>
		);
	}
	if (!template) {
		return (
			<div className="flex items-center gap-2 rounded-md border border-[var(--alert)] bg-[var(--alert-soft)] p-3 text-[13px] text-[var(--alert)]">
				<AlertCircle className="size-4 shrink-0" />
				<span>{promptError ?? "Prompt template unavailable."}</span>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
				<div className="flex gap-1 rounded-md bg-[var(--bg-active)] p-1">
					{PROMPT_FEATURES.map((item) => (
						<button
							key={item.value}
							type="button"
							aria-pressed={feature === item.value}
							onClick={() => selectFeature(item.value)}
							className={cx(
								"h-8 px-3 text-[13px] font-bold transition-colors",
								feature === item.value
									? "rounded bg-[var(--panel)] text-[var(--ink)] shadow-sm"
									: "text-[var(--ink-soft)] hover:text-[var(--ink)]",
							)}
						>
							{item.label}
						</button>
					))}
				</div>
				<label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
					<input
						type="checkbox"
						checked={advanced}
						onChange={(event) => setAdvanced(event.target.checked)}
					/>
					Advanced mode
				</label>
			</div>

			<div>
				<h2 className="text-[16px] font-bold text-[var(--ink)]">
					{template.definition.label}
				</h2>
				<p className="mt-1 text-[13px] text-[var(--ink-soft)]">
					{template.definition.description}
				</p>
			</div>

			{template.template.parseError ? (
				<div className="flex items-start gap-2 rounded-md border border-[var(--alert)] bg-[var(--alert-soft)] p-3 text-[13px] text-[var(--alert)]">
					<AlertCircle className="mt-0.5 size-4 shrink-0" />
					<span>
						Template parsing failed; defaults are shown. Saving requires
						explicit confirmation because it replaces the original file.{" "}
						{template.template.parseError}
					</span>
				</div>
			) : null}

			<div className="flex flex-col gap-2">
				<label
					htmlFor="prompt-template-system"
					className="text-[13px] font-bold text-[var(--ink)]"
				>
					System message
				</label>
				<textarea
					id="prompt-template-system"
					value={system}
					onChange={(event) => setSystem(event.target.value)}
					className={cx(
						textFieldClass,
						"min-h-24 resize-y font-mono text-[13px]",
					)}
				/>
				{advanced ? (
					<AdvancedPromptPreview
						feature={feature}
						protocol={template.definition.protocol}
						section="system"
					/>
				) : null}
			</div>

			<div className="flex flex-col gap-2">
				{advanced ? (
					<AdvancedPromptPreview
						feature={feature}
						protocol={template.definition.protocol}
						section="header"
					/>
				) : null}
				<label
					htmlFor="prompt-template-requirements"
					className="text-[13px] font-bold text-[var(--ink)]"
				>
					Requirements
				</label>
				<textarea
					id="prompt-template-requirements"
					value={requirements}
					onChange={(event) => setRequirements(event.target.value)}
					className={cx(
						textFieldClass,
						"min-h-64 resize-y font-mono text-[13px]",
					)}
				/>
				{advanced ? (
					<AdvancedPromptPreview
						feature={feature}
						protocol={template.definition.protocol}
						section="requirements"
					/>
				) : null}
			</div>

			<div className="flex flex-col gap-3 border-t border-[var(--line)] pt-4">
				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						onClick={() => void saveTemplate()}
						disabled={saving || !system.trim() || !requirements.trim()}
						className={primaryButtonClass}
					>
						<Save className="size-4" />
						{saving ? "Saving..." : "Save template"}
					</button>
					<button
						type="button"
						onClick={() => void resetTemplate()}
						disabled={saving || !template.template.isCustom}
						className={secondaryButtonClass}
					>
						<RotateCcw className="size-4" />
						Restore default
					</button>
				</div>
				<p className="text-[12px] leading-5 text-[var(--ink-soft)]">
					Changing a template invalidates matching AI caches. The next
					production run may incur real AI usage charges; saving during an
					active run can cause that result to be discarded and regenerated.
				</p>
			</div>

			<div className="flex flex-col gap-4 border-t border-[var(--line)] pt-5">
				<div className="flex items-center gap-2">
					<ShieldCheck className="size-4 text-[var(--brand)]" />
					<h3 className="text-[14px] font-bold text-[var(--ink)]">
						Playground
					</h3>
				</div>

				{feature === "period-digest" ? (
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="flex flex-col gap-1.5 text-[12px] font-semibold text-[var(--ink-soft)]">
							Period
							<select
								value={period}
								onChange={(event) =>
									setPeriod(event.target.value as typeof period)
								}
								className={selectFieldClass}
							>
								<option value="today">Today</option>
								<option value="24h">24h</option>
								<option value="yesterday">Yesterday</option>
								<option value="week">Week</option>
							</select>
						</label>
						<label className="flex flex-col gap-1.5 text-[12px] font-semibold text-[var(--ink-soft)]">
							Content source
							<select
								value={contentSource}
								onChange={(event) =>
									setContentSource(event.target.value as typeof contentSource)
								}
								className={selectFieldClass}
							>
								<option value="all">All local sources</option>
								<option value="following">Following</option>
								<option value="for_you">For You</option>
							</select>
						</label>
					</div>
				) : feature === "profile-analysis" ? (
					<label className="flex flex-col gap-1.5 text-[12px] font-semibold text-[var(--ink-soft)]">
						Local profile
						<input
							value={profileHandle}
							onChange={(event) => setProfileHandle(event.target.value)}
							list="prompt-profile-options"
							placeholder="handle"
							className={textFieldClass}
						/>
						<datalist id="prompt-profile-options">
							{profileOptions.map((handle) => (
								<option key={handle} value={handle} />
							))}
						</datalist>
						{profileOptions.length === 0 ? (
							<span className="font-normal text-[var(--alert)]">
								No locally indexed profile options are available.
							</span>
						) : null}
					</label>
				) : (
					<label className="flex flex-col gap-1.5 text-[12px] font-semibold text-[var(--ink-soft)]">
						Local search query
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search the local archive"
							className={textFieldClass}
						/>
						<span className="font-normal">
							Playground uses local-only mode. The production default may run
							live search, so the “Live search” prompt line differs here.
						</span>
					</label>
				)}

				<div className="flex gap-2">
					{running ? (
						<button
							type="button"
							onClick={stopActiveRun}
							className={secondaryButtonClass}
						>
							<Square className="size-3.5" />
							Stop
						</button>
					) : (
						<button
							type="button"
							onClick={() => void runPlayground()}
							disabled={
								!system.trim() ||
								!requirements.trim() ||
								(feature === "profile-analysis" && !profileHandle.trim()) ||
								(feature === "search-discussion" && !query.trim())
							}
							className={primaryButtonClass}
						>
							<Play className="size-4" />
							Run
						</button>
					)}
					{running ? (
						<span className="self-center text-[12px] text-[var(--ink-soft)]">
							Running...
						</span>
					) : null}
				</div>

				{streamedMarkdown ? (
					<div className="min-h-40 rounded-md border border-[var(--line)] bg-[var(--panel)] p-4">
						<MarkdownViewer markdown={streamedMarkdown} />
						{result ? (
							<p className="mt-4 border-t border-[var(--line)] pt-3 text-[11px] text-[var(--ink-soft)]">
								{result.parseStatus === "structured"
									? "Structured output parsed"
									: "Structured output fallback used"}{" "}
								· {new Date(result.generatedAt).toLocaleString()}
							</p>
						) : null}
					</div>
				) : null}
			</div>

			{promptError ? (
				<div className="flex items-center gap-2 rounded-md border border-[var(--alert)] bg-[var(--alert-soft)] p-3 text-[13px] text-[var(--alert)]">
					<AlertCircle className="size-4 shrink-0" />
					<span>{promptError}</span>
				</div>
			) : null}
			{message ? (
				<div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-[13px] text-emerald-600">
					<CheckCircle className="size-4 shrink-0" />
					<span>{message}</span>
				</div>
			) : null}
		</div>
	);
}
