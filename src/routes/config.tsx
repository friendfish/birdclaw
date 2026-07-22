import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Save, AlertCircle, CheckCircle, RefreshCw } from "lucide-react";
import { fetchJson } from "#/lib/api-client";
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

function ConfigRoute() {
	const [activeTab, setActiveTab] = useState<"ai" | "language">("ai");

	// AI config state
	const [provider, setProvider] = useState("openai");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState("");

	// Language config state
	const [aiLanguage, setAiLanguage] = useState("zh-CN");
	const [uiLanguage, setUiLanguage] = useState("zh-CN");

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
					<div className="flex flex-col gap-6 max-w-xl">
						{/* Tabs Selector */}
						<div className="flex border-b border-[var(--line)] mb-2">
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
						</div>

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
											Your secret API key. Stored securely inside config.json on
											your machine.
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
													Select Fetched Model ({availableModels.length} models)
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
					</div>
				)}
			</div>
		</section>
	);
}
