import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	AlertCircle,
	CheckCircle,
	RefreshCw,
	Save,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { PromptTemplatesPanel } from "#/components/PromptTemplatesPanel";
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

const digestScheduleTimeSchema = z.object({
	hour: z.number(),
	minute: z.number(),
	weekday: z.number().optional(),
});

const freshnessStatusSchema = z.object({
	status: z.string(),
	dueAt: z.string(),
	fireAt: z.string(),
	consumedAt: z.string().optional(),
	completedAt: z.string().optional(),
	startedAt: z.string().optional(),
	failedAt: z.string().optional(),
	installError: z.string().optional(),
	retryAt: z.string().optional(),
	retryCount: z.number().optional(),
	pageRecoveryUsedAt: z.string().optional(),
});

const digestScheduleResponseSchema = z.object({
	ok: z.boolean(),
	archiveDir: z.string(),
	freshnessHours: z.number(),
	schedule: z.object({
		today: digestScheduleTimeSchema,
		"24h": digestScheduleTimeSchema,
		yesterday: digestScheduleTimeSchema,
		week: digestScheduleTimeSchema,
	}),
	freshness: z.object({
		today: freshnessStatusSchema.nullable(),
		"24h": freshnessStatusSchema.nullable(),
	}),
	runs: z.object({
		today: z
			.object({
				phase: z.string(),
				finishedAt: z.string().optional(),
				error: z.string().optional(),
			})
			.passthrough()
			.nullable(),
		"24h": z
			.object({
				phase: z.string(),
				finishedAt: z.string().optional(),
				error: z.string().optional(),
			})
			.passthrough()
			.nullable(),
	}),
});

function digestFreshnessStatusText(
	freshness: z.infer<typeof freshnessStatusSchema>,
): string {
	if (freshness.status === "scheduled") {
		return `下次超时 ${new Date(freshness.dueAt).toLocaleString()}`;
	}
	if (freshness.status === "running") {
		return "正在刷新";
	}
	if (freshness.status === "retryable") {
		return freshness.retryAt
			? `重试于 ${new Date(freshness.retryAt).toLocaleString()}`
			: "等待后台重试";
	}
	if (freshness.status === "failed") {
		return freshness.pageRecoveryUsedAt
			? "今日刷新已结束"
			: "自动重试已结束，等待页面恢复";
	}
	if (freshness.status === "error") {
		return `调度安装失败：${freshness.installError ?? "未知错误"}`;
	}
	if (freshness.status === "consumed") {
		return "今日超时更新已完成";
	}
	if (freshness.status === "disabled") {
		return "今日不再触发超时更新";
	}
	return "超时更新状态未知";
}

const birdCredentialStatusSchema = z
	.object({
		configured: z.boolean(),
		complete: z.boolean(),
		updatedAt: z.string().optional(),
	})
	.strict();

const birdCredentialsResponseSchema = z
	.object({
		ok: z.boolean(),
		status: birdCredentialStatusSchema,
	})
	.strict();

const birdCredentialsTestResponseSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
	})
	.strict();

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

function automaticBatchEstimate(
	freshnessHours: number,
	times: Array<{ hour: number; minute: number }>,
) {
	const freshnessRuns = times.reduce((total, time) => {
		const remainingHours = 24 - time.hour - time.minute / 60;
		return (
			total + Math.max(0, Math.floor((remainingHours - 0.001) / freshnessHours))
		);
	}, 0);
	return times.length + freshnessRuns;
}

function CredentialsPanel() {
	const [status, setStatus] = useState<z.infer<
		typeof birdCredentialStatusSchema
	> | null>(null);
	const [authToken, setAuthToken] = useState("");
	const [ct0, setCt0] = useState("");
	const [activeOperation, setActiveOperation] = useState<
		"save" | "test" | "clear" | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		fetchJson(
			"/api/bird-credentials",
			undefined,
			birdCredentialsResponseSchema,
			"Failed to load X credential status",
		)
			.then((response) => {
				if (active) setStatus(response.status);
			})
			.catch((loadError) => {
				if (active) {
					setError(
						loadError instanceof Error ? loadError.message : "Load failed",
					);
				}
			});
		return () => {
			active = false;
		};
	}, []);

	const credentialFilePresent = status?.configured === true;
	const credentialsUsable = status?.complete === true;
	const canSave =
		authToken.trim().length > 0 &&
		ct0.trim().length > 0 &&
		activeOperation === null;

	const handleSaveCredentials = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!canSave) return;
		setActiveOperation("save");
		setError(null);
		setSuccessMessage(null);
		try {
			const response = await fetchJson(
				"/api/bird-credentials",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ authToken, ct0 }),
				},
				birdCredentialsResponseSchema,
				"Failed to save X credentials",
			);
			setStatus(response.status);
			setAuthToken("");
			setCt0("");
			setSuccessMessage("Credentials saved.");
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : "Save failed");
		} finally {
			setActiveOperation(null);
		}
	};

	const handleTestCredentials = async () => {
		setActiveOperation("test");
		setError(null);
		setSuccessMessage(null);
		try {
			const response = await fetchJson(
				"/api/bird-credentials-test",
				{ method: "POST" },
				birdCredentialsTestResponseSchema,
				"Credential test failed",
			);
			if (!response.ok) {
				setError(response.error || "Credential test failed");
				return;
			}
			setSuccessMessage("Credentials verified.");
		} catch (testError) {
			setError(
				testError instanceof Error
					? testError.message
					: "Credential test failed",
			);
		} finally {
			setActiveOperation(null);
		}
	};

	const handleClearCredentials = async () => {
		setActiveOperation("clear");
		setError(null);
		setSuccessMessage(null);
		try {
			const response = await fetchJson(
				"/api/bird-credentials",
				{ method: "DELETE" },
				birdCredentialsResponseSchema,
				"Failed to clear X credentials",
			);
			setStatus(response.status);
			setAuthToken("");
			setCt0("");
			setSuccessMessage("Credentials cleared.");
		} catch (clearError) {
			setError(
				clearError instanceof Error ? clearError.message : "Clear failed",
			);
		} finally {
			setActiveOperation(null);
		}
	};

	return (
		<form onSubmit={handleSaveCredentials} className="flex flex-col gap-6">
			<div className="flex items-center justify-between gap-4 border-b border-[var(--line)] pb-4">
				<div className="min-w-0">
					<div className="text-[14px] font-bold text-[var(--ink)]">
						{status === null
							? "Loading status..."
							: credentialsUsable
								? "Configured"
								: credentialFilePresent
									? "Incomplete configuration"
									: "Not configured"}
					</div>
					{credentialFilePresent && status?.updatedAt ? (
						<time
							dateTime={status.updatedAt}
							className="text-[12px] text-[var(--ink-soft)]"
						>
							Updated {new Date(status.updatedAt).toLocaleString()}
						</time>
					) : null}
				</div>
				<span
					className={cx(
						"size-2.5 shrink-0 rounded-full",
						credentialsUsable
							? "bg-emerald-500"
							: credentialFilePresent
								? "bg-amber-500"
								: "bg-[var(--ink-faint)]",
					)}
					aria-hidden="true"
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<label
					htmlFor="bird-auth-token"
					className="text-[14px] font-bold text-[var(--ink)]"
				>
					AUTH_TOKEN
				</label>
				<input
					id="bird-auth-token"
					type="password"
					autoComplete="off"
					value={authToken}
					onChange={(event) => setAuthToken(event.target.value)}
					className={textFieldClass}
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<label
					htmlFor="bird-ct0"
					className="text-[14px] font-bold text-[var(--ink)]"
				>
					CT0
				</label>
				<input
					id="bird-ct0"
					type="password"
					autoComplete="off"
					value={ct0}
					onChange={(event) => setCt0(event.target.value)}
					className={textFieldClass}
				/>
			</div>

			{error ? (
				<div className="flex items-center gap-2 rounded-md border border-[var(--alert)] bg-[var(--alert-soft)] p-3 text-[14px] text-[var(--alert)]">
					<AlertCircle className="size-4 shrink-0" />
					<span>{error}</span>
				</div>
			) : null}

			{successMessage ? (
				<div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-[14px] text-emerald-600">
					<CheckCircle className="size-4 shrink-0" />
					<span>{successMessage}</span>
				</div>
			) : null}

			<div className="flex flex-wrap gap-2">
				<button
					type="submit"
					disabled={!canSave}
					className={primaryButtonClass}
				>
					<Save className="size-4" />
					{activeOperation === "save"
						? "Saving..."
						: credentialFilePresent
							? "Replace"
							: "Save"}
				</button>
				<button
					type="button"
					onClick={handleTestCredentials}
					disabled={!credentialsUsable || activeOperation !== null}
					className={secondaryButtonClass}
				>
					<ShieldCheck className="size-4" />
					{activeOperation === "test" ? "Testing..." : "Test Credentials"}
				</button>
				<button
					type="button"
					onClick={handleClearCredentials}
					disabled={!credentialFilePresent || activeOperation !== null}
					className={secondaryButtonClass}
				>
					<Trash2 className="size-4" />
					{activeOperation === "clear" ? "Clearing..." : "Clear Credentials"}
				</button>
			</div>
		</form>
	);
}

function ConfigRoute() {
	const [activeTab, setActiveTab] = useState<
		"ai" | "credentials" | "language" | "schedule" | "prompts"
	>("ai");

	// AI config state
	const [provider, setProvider] = useState("openai");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState("");

	// Language config state
	const [aiLanguage, setAiLanguage] = useState("zh-CN");
	const [uiLanguage, setUiLanguage] = useState("zh-CN");

	// Digest scheduling state
	const [todayTime, setTodayTime] = useState("08:00");
	const [hour24Time, setHour24Time] = useState("08:45");
	const [yesterdayTime, setYesterdayTime] = useState("01:00");
	const [weekTime, setWeekTime] = useState("02:00");
	const [archiveDir, setArchiveDir] = useState("");
	const [freshnessHours, setFreshnessHours] = useState(12);
	const [digestScheduleStatus, setDigestScheduleStatus] = useState<
		z.infer<typeof digestScheduleResponseSchema> | undefined
	>();
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
					setFreshnessHours(response.freshnessHours);
					setDigestScheduleStatus(response);
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
						freshnessHours,
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
			setDigestScheduleStatus(response);
			if (response.ok) {
				setScheduleSuccess(true);
				setTimeout(() => setScheduleSuccess(false), 3000);
			} else {
				setScheduleError(
					"配置已保存，但部分后台调度安装失败。请检查下方状态。",
				);
			}
		} catch (err) {
			setScheduleError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setScheduleSaving(false);
		}
	};
	const estimatedAutomaticBatches = automaticBatchEstimate(freshnessHours, [
		parseTime(todayTime),
		parseTime(hour24Time),
	]);

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
								onClick={() => setActiveTab("credentials")}
								className={cx(
									"px-4 py-2.5 font-bold text-[14px] border-b-2 transition-all cursor-pointer",
									activeTab === "credentials"
										? "border-[var(--brand)] text-[var(--brand)]"
										: "border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]",
								)}
							>
								X Credentials
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
								摘要调度
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
										每天定时更新 Today 当前摘要；手动刷新仍然可用。
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
										每天定时更新 24h 当前摘要；手动刷新仍然可用。
									</p>
								</div>

								<div className="flex flex-col gap-1.5">
									<label
										htmlFor="digest-freshness-hours"
										className="text-[14px] font-bold text-[var(--ink)]"
									>
										Today/24h 有效时长（小时）
									</label>
									<input
										id="digest-freshness-hours"
										type="number"
										min={1}
										max={24}
										step={1}
										value={freshnessHours}
										onChange={(event) =>
											setFreshnessHours(Number(event.target.value))
										}
										className={textFieldClass}
										required
									/>
									<p className="text-[12px] text-[var(--ink-soft)]">
										当前摘要生成后按此时长后台更新；到期跨日则不再触发。
									</p>
									<p className="text-[12px] font-semibold text-[var(--ink)]">
										预计每天 {estimatedAutomaticBatches}{" "}
										个自动批次，最多调用模型 {estimatedAutomaticBatches * 3}{" "}
										次。
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
										Yesterday/Week 定时摘要（Markdown +
										JSON）的归档根目录。留空使用默认路径。
									</p>
								</div>

								{digestScheduleStatus ? (
									<div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
										{(["today", "24h"] as const).map((period) => {
											const freshness = digestScheduleStatus.freshness[period];
											const run = digestScheduleStatus.runs[period];
											const freshnessText = !freshness
												? "调度尚未初始化"
												: digestFreshnessStatusText(freshness);
											return (
												<div
													key={period}
													className="flex flex-col gap-1 py-3 min-[640px]:flex-row min-[640px]:items-center min-[640px]:justify-between"
												>
													<span className="text-[13px] font-bold text-[var(--ink)]">
														{period === "today" ? "Today" : "24h"} ·{" "}
														{freshnessText}
													</span>
													<span className="text-[12px] text-[var(--ink-soft)]">
														最近批次：{run?.phase ?? "暂无"}
													</span>
												</div>
											);
										})}
									</div>
								) : null}

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
						) : activeTab === "credentials" ? (
							<CredentialsPanel />
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
