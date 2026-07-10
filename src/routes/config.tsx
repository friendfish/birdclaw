import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Save, AlertCircle, CheckCircle } from "lucide-react";
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
});

function ConfigRoute() {
	const [provider, setProvider] = useState("openai");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
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
		if (nextProvider === "deepseek") {
			setBaseUrl("https://api.deepseek.com/v1");
			setModel("deepseek-chat");
		} else if (nextProvider === "openai") {
			setBaseUrl("https://api.openai.com/v1");
			setModel("gpt-4o");
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
						provider,
						baseUrl,
						apiKey,
						model,
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
						<h1 className={pageTitleClass}>AI Config</h1>
						<p className={pageSubtitleClass}>
							Configure AI Model Provider and Model Settings.
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
					<form onSubmit={handleSave} className="flex flex-col gap-6 max-w-xl">
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
								<option value="custom">Custom / Other</option>
							</select>
							<p className="text-[12px] text-[var(--ink-soft)]">
								Select the LLM provider you want system digests and analysis to
								use.
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
								The API endpoint URL for standard chat completion requests.
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
								Your secret API key. Stored securely inside config.json on your
								machine.
							</p>
						</div>

						<div className="flex flex-col gap-1.5">
							<label className="text-[14px] font-bold text-[var(--ink)]">
								Model Name
							</label>
							<input
								type="text"
								value={model}
								onChange={(e) => setModel(e.target.value)}
								placeholder="gpt-4o"
								className={textFieldClass}
								required
							/>
							<p className="text-[12px] text-[var(--ink-soft)]">
								The specific model identifier to target (e.g. deepseek-chat,
								deepseek-reasoner, gpt-4o).
							</p>
						</div>

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
								className={cx(primaryButtonClass, "w-full min-[480px]:w-auto")}
							>
								<Save className="size-4" />
								{saving ? "Saving..." : "Save Config"}
							</button>
						</div>
					</form>
				)}
			</div>
		</section>
	);
}
