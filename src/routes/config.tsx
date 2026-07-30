import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	AlertCircle,
	CheckCircle,
	Play,
	RefreshCw,
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
import { z } from "zod";
import {
	cx,
	pageHeaderClass,
	pageHeaderRowClass,
	pageTitleClass,
	pageSubtitleClass,
	textFieldClass,
	selectFieldClass,
	primaryButtonClass,
	secondaryButtonClass,
	mainColumnClass,
} from "#/lib/ui";

export const Route = createFileRoute("/config")({
	component: ConfigRoute,
});

const configResponseSchema = z.object({
	ok: z.boolean(),
	ai: z.object({
		provider: z.string().optional(),
		baseUrl: z.string().optional(),
		apiKey: z.string().optional(),
		model: z.string().optional(),
	}),
	language: z
		.object({
			aiLanguage: z.string().optional(),
			uiLanguage: z.string().optional(),
		})
		.optional(),
});

const modelsResponseSchema = z.object({
	ok: z.boolean(),
	models: z.array(z.string()).optional(),
	error: z.string().optional(),
});

const digestScheduleTimeSchema = z.object({
	hour: z.number(),
	minute: z.number(),
	weekday: z.number().optional(),
});

const digestScheduleResponseSchema = z.object({
	ok: z.boolean(),
	archiveDir: z.string(),
	schedule: z.object({
		today: digestScheduleTimeSchema,
		"24h": digestScheduleTimeSchema,
		yesterday: digestScheduleTimeSchema,
		week: digestScheduleTimeSchema,
	}),
});

function formatTime(hour: number, minute: number) {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTime(value: string): { hour: number; minute: number } {
	const [hourText, minuteText] = value.split(":");
	return {
		hour: Number(hourText) || 0,
		minute: Number(minuteText) || 0,
	};
}

const PROMPT_FEATURES: Array<{ value: PromptFeature; label: string }> = [
	{ value: "period-digest", label: "Today" },
	{ value: "profile-analysis", label: "Analyse" },
	{ value: "search-discussion", label: "Discuss" },
];

type PlaygroundViewResult = PlaygroundResultBase;

function AdvancedPromptPreview({
	feature,
	protocol,
	section,
}: {
	feature: PromptFeature;
	protocol: { system: string; requirements: string };
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
				? `<${header}>\n\nRequirements:`
				: `${protocol.requirements}${languagePlaceholder}\n\nDataset:\n<local data selected below>`;
	return (
		<div className="rounded-md border border-[var(--line)] bg-[var(--bg-active)] p-3 font-mono text-[12px] leading-5 text-[var(--ink-soft)] whitespace-pre-wrap">
			{content}
		</div>
	);
}

function PromptTemplatesPanel({ aiLanguage }: { aiLanguage: string }) {
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
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

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
		abortRef.current = abortController;
		setRunning(true);
		setPromptError(null);
		setMessage(null);
		setResult(null);
		setStreamedMarkdown("");
		try {
			if (feature === "profile-analysis") {
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
				setResult(response.result);
				setStreamedMarkdown(response.result.markdown);
				return;
			}

			const isToday = feature === "period-digest";
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
			if (!abortController.signal.aborted) {
				setPromptError(error instanceof Error ? error.message : "Run failed");
			}
		} finally {
			if (abortRef.current === abortController) abortRef.current = null;
			setRunning(false);
		}
	};

	if (loading || !template) {
		return (
			<div className="py-10 text-center text-[14px] text-[var(--ink-soft)]">
				Loading prompt template...
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
							onClick={() => setFeature(item.value)}
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
							onClick={() => abortRef.current?.abort()}
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

function ConfigRoute() {
	const [activeTab, setActiveTab] = useState<
		"ai" | "language" | "schedule" | "prompts"
	>("ai");

	// AI config state
	const [provider, setProvider] = useState("openai");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState("");

	// Language config state
	const [aiLanguage, setAiLanguage] = useState("zh-CN");
	const [uiLanguage, setUiLanguage] = useState("zh-CN");

	// Digest archive schedule state
	const [todayTime, setTodayTime] = useState("08:00");
	const [hour24Time, setHour24Time] = useState("08:45");
	const [yesterdayTime, setYesterdayTime] = useState("01:00");
	const [weekTime, setWeekTime] = useState("02:00");
	const [archiveDir, setArchiveDir] = useState("");
	const [scheduleSaving, setScheduleSaving] = useState(false);
	const [scheduleError, setScheduleError] = useState<string | null>(null);
	const [scheduleSuccess, setScheduleSuccess] = useState(false);

	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [fetchingModels, setFetchingModels] = useState(false);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	useEffect(() => {
		async function loadConfig() {
			try {
				const response = await fetchJson(
					"/api/config",
					undefined,
					configResponseSchema,
					"Failed to load AI config",
				);
				if (response.ok) {
					setProvider(response.ai.provider || "openai");
					setBaseUrl(response.ai.baseUrl || "");
					setApiKey(response.ai.apiKey || "");
					setModel(response.ai.model || "");
					if (response.language) {
						setAiLanguage(response.language.aiLanguage || "zh-CN");
						setUiLanguage(response.language.uiLanguage || "zh-CN");
					}
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Load failed");
			} finally {
				setLoading(false);
			}
		}
		loadConfig();
	}, []);

	useEffect(() => {
		async function loadSchedule() {
			try {
				const response = await fetchJson(
					"/api/digest-schedule",
					undefined,
					digestScheduleResponseSchema,
					"Failed to load digest schedule",
				);
				if (response.ok) {
					setTodayTime(
						formatTime(
							response.schedule.today.hour,
							response.schedule.today.minute,
						),
					);
					setHour24Time(
						formatTime(
							response.schedule["24h"].hour,
							response.schedule["24h"].minute,
						),
					);
					setYesterdayTime(
						formatTime(
							response.schedule.yesterday.hour,
							response.schedule.yesterday.minute,
						),
					);
					setWeekTime(
						formatTime(
							response.schedule.week.hour,
							response.schedule.week.minute,
						),
					);
					setArchiveDir(response.archiveDir);
				}
			} catch (err) {
				setScheduleError(err instanceof Error ? err.message : "Load failed");
			}
		}
		loadSchedule();
	}, []);

	// Auto-fill defaults when provider changes
	const handleProviderChange = (nextProvider: string) => {
		setProvider(nextProvider);
		setAvailableModels([]); // Reset fetched models list
		if (nextProvider === "deepseek") {
			setBaseUrl("https://api.deepseek.com/v1");
			setModel("deepseek-chat");
		} else if (nextProvider === "openai") {
			setBaseUrl("https://api.openai.com/v1");
			setModel("gpt-4o");
		} else if (nextProvider === "google") {
			setBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai");
			setModel("gemini-2.5-flash");
		} else if (nextProvider === "openrouter") {
			setBaseUrl("https://openrouter.ai/api/v1");
			setModel("google/gemini-2.5-flash");
		}
	};

	const handleFetchModels = async () => {
		if (!baseUrl.trim() || !apiKey.trim()) {
			setError("API Base URL and API Key are required to fetch models.");
			return;
		}

		setFetchingModels(true);
		setError(null);
		setAvailableModels([]);

		try {
			const response = await fetchJson(
				"/api/config-models",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						baseUrl,
						apiKey,
					}),
				},
				modelsResponseSchema,
				"Failed to fetch models",
			);
			if (response.ok && response.models) {
				setAvailableModels(response.models);
			} else if (response.error) {
				setError(response.error);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch models");
		} finally {
			setFetchingModels(false);
		}
	};

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		setSuccess(false);

		try {
			const response = await fetchJson(
				"/api/config",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						ai: {
							provider,
							baseUrl,
							apiKey,
							model,
						},
						language: {
							aiLanguage,
							uiLanguage,
						},
					}),
				},
				configResponseSchema,
				"Failed to save config",
			);
			if (response.ok) {
				setSuccess(true);
				setTimeout(() => setSuccess(false), 3000);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	};

	const handleScheduleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		setScheduleSaving(true);
		setScheduleError(null);
		setScheduleSuccess(false);

		try {
			const response = await fetchJson(
				"/api/digest-schedule",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						archiveDir,
						schedule: {
							today: parseTime(todayTime),
							"24h": parseTime(hour24Time),
							yesterday: parseTime(yesterdayTime),
							week: parseTime(weekTime),
						},
					}),
				},
				digestScheduleResponseSchema,
				"Failed to save digest schedule",
			);
			if (response.ok) {
				setScheduleSuccess(true);
				setTimeout(() => setScheduleSuccess(false), 3000);
			}
		} catch (err) {
			setScheduleError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setScheduleSaving(false);
		}
	};

	return (
		<section className={mainColumnClass}>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>System Config</h1>
						<p className={pageSubtitleClass}>
							Configure system settings, model providers, and language
							preferences.
						</p>
					</div>
				</div>
			</header>

			<div className="flex-1 overflow-y-auto px-4 py-6">
				{loading ? (
					<div className="flex items-center justify-center py-12 text-[var(--ink-soft)]">
						Loading configuration...
					</div>
				) : (
					<div
						className={cx(
							"flex flex-col gap-6",
							activeTab === "prompts" ? "max-w-5xl" : "max-w-xl",
						)}
					>
						{/* Tabs Selector */}
						<div className="flex flex-wrap border-b border-[var(--line)] mb-2">
							<button
								type="button"
								onClick={() => {
									setError(null);
									setSuccess(false);
									setActiveTab("ai");
								}}
								className={cx(
									"px-4 py-2.5 font-bold text-[14px] border-b-2 transition-all cursor-pointer",
									activeTab === "ai"
										? "border-[var(--brand)] text-[var(--brand)]"
										: "border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]",
								)}
							>
								模型配置
							</button>
							<button
								type="button"
								onClick={() => {
									setError(null);
									setSuccess(false);
									setActiveTab("language");
								}}
								className={cx(
									"px-4 py-2.5 font-bold text-[14px] border-b-2 transition-all cursor-pointer",
									activeTab === "language"
										? "border-[var(--brand)] text-[var(--brand)]"
										: "border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]",
								)}
							>
								语言配置
							</button>
							<button
								type="button"
								onClick={() => {
									setScheduleError(null);
									setScheduleSuccess(false);
									setActiveTab("schedule");
								}}
								className={cx(
									"px-4 py-2.5 font-bold text-[14px] border-b-2 transition-all cursor-pointer",
									activeTab === "schedule"
										? "border-[var(--brand)] text-[var(--brand)]"
										: "border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]",
								)}
							>
								摘要归档调度
							</button>
							<button
								type="button"
								onClick={() => setActiveTab("prompts")}
								className={cx(
									"px-4 py-2.5 font-bold text-[14px] border-b-2 transition-all cursor-pointer",
									activeTab === "prompts"
										? "border-[var(--brand)] text-[var(--brand)]"
										: "border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]",
								)}
							>
								提示词
							</button>
						</div>

						{activeTab === "schedule" ? (
							<form
								onSubmit={handleScheduleSave}
								className="flex flex-col gap-6"
							>
								<div className="flex flex-col gap-1.5">
									<label className="text-[14px] font-bold text-[var(--ink)]">
										Today
									</label>
									<input
										type="time"
										value={todayTime}
										onChange={(e) => setTodayTime(e.target.value)}
										className={textFieldClass}
										required
									/>
									<p className="text-[12px] text-[var(--ink-soft)]">
										每天定时生成 Today 摘要（All/Following/For
										You）并归档；手动刷新仍然可用。
									</p>
								</div>

								<div className="flex flex-col gap-1.5">
									<label className="text-[14px] font-bold text-[var(--ink)]">
										24h
									</label>
									<input
										type="time"
										value={hour24Time}
										onChange={(e) => setHour24Time(e.target.value)}
										className={textFieldClass}
										required
									/>
									<p className="text-[12px] text-[var(--ink-soft)]">
										每天定时生成 24h 摘要并归档；手动刷新仍然可用。
									</p>
								</div>

								<div className="flex flex-col gap-1.5">
									<label className="text-[14px] font-bold text-[var(--ink)]">
										Yesterday
									</label>
									<input
										type="time"
										value={yesterdayTime}
										onChange={(e) => setYesterdayTime(e.target.value)}
										className={textFieldClass}
										required
									/>
									<p className="text-[12px] text-[var(--ink-soft)]">
										每天定时生成 Yesterday
										摘要并归档；该周期已改为纯定时，不再提供手动刷新。
									</p>
								</div>

								<div className="flex flex-col gap-1.5">
									<label className="text-[14px] font-bold text-[var(--ink)]">
										Week（每周一）
									</label>
									<input
										type="time"
										value={weekTime}
										onChange={(e) => setWeekTime(e.target.value)}
										className={textFieldClass}
										required
									/>
									<p className="text-[12px] text-[var(--ink-soft)]">
										每周一定时生成 Week
										摘要并归档；星期固定为周一，不可配置。该周期已改为纯定时，不再提供手动刷新。
									</p>
								</div>

								<div className="flex flex-col gap-1.5">
									<label className="text-[14px] font-bold text-[var(--ink)]">
										归档目录
									</label>
									<input
										type="text"
										value={archiveDir}
										onChange={(e) => setArchiveDir(e.target.value)}
										placeholder="~/.birdclaw/digest-archive"
										className={textFieldClass}
									/>
									<p className="text-[12px] text-[var(--ink-soft)]">
										定时生成的摘要（Markdown +
										JSON）落盘归档的根目录。留空使用默认路径。
									</p>
								</div>

								{scheduleError ? (
									<div className="flex items-center gap-2 rounded-md border border-[var(--alert)] bg-[var(--alert-soft)] p-3 text-[14px] text-[var(--alert)]">
										<AlertCircle className="size-4 shrink-0" />
										<span>{scheduleError}</span>
									</div>
								) : null}

								{scheduleSuccess ? (
									<div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-[14px] text-emerald-600">
										<CheckCircle className="size-4 shrink-0" />
										<span>调度已保存并生效。</span>
									</div>
								) : null}

								<div className="mt-2 flex">
									<button
										type="submit"
										disabled={scheduleSaving}
										className={cx(
											primaryButtonClass,
											"w-full min-[480px]:w-auto",
										)}
									>
										<Save className="size-4" />
										{scheduleSaving ? "Saving..." : "Save Config"}
									</button>
								</div>
							</form>
						) : activeTab === "prompts" ? (
							<PromptTemplatesPanel aiLanguage={aiLanguage} />
						) : (
							<form onSubmit={handleSave} className="flex flex-col gap-6">
								{activeTab === "ai" ? (
									<div className="flex flex-col gap-6">
										<div className="flex flex-col gap-1.5">
											<label className="text-[14px] font-bold text-[var(--ink)]">
												Model Provider
											</label>
											<select
												value={provider}
												onChange={(e) => handleProviderChange(e.target.value)}
												className={selectFieldClass}
											>
												<option value="openai">OpenAI</option>
												<option value="deepseek">DeepSeek</option>
												<option value="google">
													Google Gemini (OpenAI Compat)
												</option>
												<option value="openrouter">OpenRouter</option>
												<option value="custom">Custom / Other</option>
											</select>
											<p className="text-[12px] text-[var(--ink-soft)]">
												Select the LLM provider you want system digests and
												analysis to use.
											</p>
										</div>

										<div className="flex flex-col gap-1.5">
											<label className="text-[14px] font-bold text-[var(--ink)]">
												API Base URL
											</label>
											<input
												type="url"
												value={baseUrl}
												onChange={(e) => setBaseUrl(e.target.value)}
												placeholder="https://api.openai.com/v1"
												className={textFieldClass}
												required
											/>
											<p className="text-[12px] text-[var(--ink-soft)]">
												The API endpoint URL for standard chat completion
												requests.
											</p>
										</div>

										<div className="flex flex-col gap-1.5">
											<label className="text-[14px] font-bold text-[var(--ink)]">
												API Key
											</label>
											<input
												type="password"
												value={apiKey}
												onChange={(e) => setApiKey(e.target.value)}
												placeholder="sk-..."
												className={textFieldClass}
												required
											/>
											<p className="text-[12px] text-[var(--ink-soft)]">
												Your secret API key. Stored securely inside config.json
												on your machine.
											</p>
										</div>

										<div className="flex flex-col gap-1.5">
											<div className="flex items-center justify-between">
												<label className="text-[14px] font-bold text-[var(--ink)]">
													Model Name
												</label>
												<button
													type="button"
													onClick={handleFetchModels}
													disabled={fetchingModels || !baseUrl || !apiKey}
													className={cx(
														secondaryButtonClass,
														"py-1 px-3 text-[11px] h-7 min-h-0",
													)}
												>
													<RefreshCw
														className={cx(
															"size-3",
															fetchingModels && "animate-spin",
														)}
													/>
													{fetchingModels ? "Fetching..." : "Fetch Models"}
												</button>
											</div>
											<input
												type="text"
												value={model}
												onChange={(e) => setModel(e.target.value)}
												placeholder="gpt-4o"
												className={textFieldClass}
												required
											/>
											<p className="text-[12px] text-[var(--ink-soft)]">
												The specific model identifier to target (e.g.
												deepseek-chat, deepseek-reasoner, gpt-4o).
											</p>

											{availableModels.length > 0 ? (
												<div className="mt-2 flex flex-col gap-1.5 rounded-md border border-[var(--line)] bg-[var(--bg-active)] p-3">
													<label className="text-[12px] font-semibold text-[var(--ink-soft)]">
														Select Fetched Model ({availableModels.length}{" "}
														models)
													</label>
													<select
														onChange={(e) => {
															if (e.target.value) setModel(e.target.value);
														}}
														className={selectFieldClass}
														defaultValue=""
													>
														<option value="" disabled>
															-- Select a model from provider --
														</option>
														{availableModels.map((m) => (
															<option key={m} value={m}>
																{m}
															</option>
														))}
													</select>
												</div>
											) : null}
										</div>
									</div>
								) : (
									<div className="flex flex-col gap-6">
										<div className="flex flex-col gap-1.5">
											<label className="text-[14px] font-bold text-[var(--ink)]">
												AI 摘要生成语言
											</label>
											<select
												value={aiLanguage}
												onChange={(e) => setAiLanguage(e.target.value)}
												className={selectFieldClass}
											>
												<option value="zh-CN">
													简体中文 (Simplified Chinese)
												</option>
												<option value="en">English</option>
											</select>
											<p className="text-[12px] text-[var(--ink-soft)]">
												用于指定 Today 今日简报、用户画像分析等 LLM
												生成内容的语言。
											</p>
										</div>

										<div className="flex flex-col gap-1.5">
											<label className="text-[14px] font-bold text-[var(--ink)]">
												界面显示语言
											</label>
											<select
												value={uiLanguage}
												onChange={(e) => setUiLanguage(e.target.value)}
												className={selectFieldClass}
											>
												<option value="zh-CN">
													简体中文 (Simplified Chinese)
												</option>
												<option value="en">English (Partial Support)</option>
											</select>
											<p className="text-[12px] text-[var(--ink-soft)]">
												用于指定 Birdclaw
												本地管理界面的显示语言（部分控制面板支持）。
											</p>
										</div>
									</div>
								)}

								{error ? (
									<div className="flex items-center gap-2 rounded-md border border-[var(--alert)] bg-[var(--alert-soft)] p-3 text-[14px] text-[var(--alert)]">
										<AlertCircle className="size-4 shrink-0" />
										<span>{error}</span>
									</div>
								) : null}

								{success ? (
									<div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-[14px] text-emerald-600">
										<CheckCircle className="size-4 shrink-0" />
										<span>Configuration saved successfully!</span>
									</div>
								) : null}

								<div className="mt-2 flex">
									<button
										type="submit"
										disabled={saving}
										className={cx(
											primaryButtonClass,
											"w-full min-[480px]:w-auto",
										)}
									>
										<Save className="size-4" />
										{saving ? "Saving..." : "Save Config"}
									</button>
								</div>
							</form>
						)}
					</div>
				)}
			</div>
		</section>
	);
}
