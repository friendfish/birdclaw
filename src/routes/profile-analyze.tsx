import { createFileRoute } from "@tanstack/react-router";
import { Loader2, RefreshCw, Search, UserSearch, Sparkles, ArrowLeft } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { SyncNowButton } from "#/components/SyncNowButton";
import {
	cleanProfileHandle,
	formatProfileAnalysisCounts,
	ProfileAnalysisStatusLine,
	useProfileAnalysisStream,
} from "#/components/ProfileAnalysisStream";
import {
	cx,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	secondaryButtonClass,
} from "#/lib/ui";

function stableHue(value: string) {
	let hash = 0;
	for (const char of value) {
		hash = (hash * 31 + char.charCodeAt(0)) % 360;
	}
	return hash;
}

function stripMarkdownHeader(md: string, handle: string): string {
	// Automatically promote any headings level 4 or lower (H4, H5, H6) to H3 (###) for better visual prominence
	let processed = md.replace(/^#{4,}\s+/gm, "### ");

	const lines = processed.split("\n");
	if (lines.length > 0 && lines[0].startsWith("#")) {
		const firstLineLower = lines[0].toLowerCase();
		if (
			firstLineLower.includes(handle.toLowerCase()) ||
			firstLineLower.includes("分析") ||
			firstLineLower.includes("analysis")
		) {
			return lines.slice(1).join("\n").trim();
		}
	}
	return processed.trim();
}

export const Route = createFileRoute("/profile-analyze")({
	component: ProfileAnalyzeRoute,
	validateSearch: (search: Record<string, unknown>) => ({
		handle: typeof search.handle === "string" ? search.handle : "",
	}),
});

function ProfileAnalyzeRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [handle, setHandle] = useState(cleanProfileHandle(search.handle));
	const submittedHandle = useMemo(() => cleanProfileHandle(handle), [handle]);
	const [language, setLanguage] = useState("zh-CN");
	const analysis = useProfileAnalysisStream(submittedHandle, language);

	// Load accounts for SyncNowButton
	const [accounts, setAccounts] = useState<any[] | undefined>(undefined);

	useEffect(() => {
		fetch("/api/status")
			.then((res) => res.json())
			.then((data) => {
				if (data && data.accounts) {
					setAccounts(data.accounts);
				}
			})
			.catch((err) => console.error("Failed to load accounts", err));
	}, []);

	// Inherit global default language settings
	useEffect(() => {
		fetch("/api/config")
			.then((res) => res.json())
			.then((data) => {
				if (data && data.ok && data.language?.aiLanguage) {
					setLanguage(data.language.aiLanguage);
				}
			})
			.catch((err) => console.error("Failed to load global config language", err));
	}, []);

	// Metadata for lists
	const [metadata, setMetadata] = useState<{
		following: any[];
		analyzed: any[];
	} | null>(null);
	const [loadingMetadata, setLoadingMetadata] = useState(false);

	// Snapshots for selected handle
	const [snapshots, setSnapshots] = useState<any[]>([]);
	const [selectedSnapshot, setSelectedSnapshot] = useState<any | null>(null);

	const profileInfo = useMemo(() => {
		if (!submittedHandle) return null;
		let found = metadata?.analyzed.find((p) => p.handle.toLowerCase() === submittedHandle.toLowerCase());
		if (!found) {
			found = metadata?.following.find((p) => p.handle.toLowerCase() === submittedHandle.toLowerCase());
		}
		if (!found && analysis.context?.profile) {
			found = analysis.context.profile;
		}
		return found || { handle: submittedHandle, displayName: `@${submittedHandle}`, avatarHue: stableHue(submittedHandle) };
	}, [submittedHandle, metadata, analysis.context]);

	// Load snapshots when handle changes
	useEffect(() => {
		const urlHandle = cleanProfileHandle(search.handle);
		setHandle(urlHandle);

		if (urlHandle) {
			setSelectedSnapshot(null);
			fetch(`/api/profile-analysis-metadata?handle=${encodeURIComponent(urlHandle)}`)
				.then((res) => res.json())
				.then((data) => {
					if (data.ok && data.snapshots) {
						setSnapshots(data.snapshots);
						// If snapshots exist, default to loading the most recent snapshot immediately
						if (data.snapshots.length > 0) {
							setSelectedSnapshot(data.snapshots[0]);
						}
					}
				})
				.catch((err) => {
					console.error("Failed to load snapshots", err);
				});
		} else {
			setSnapshots([]);
			setSelectedSnapshot(null);
		}
	}, [search.handle]);

	// Load metadata (following & analyzed lists)
	useEffect(() => {
		if (!submittedHandle) {
			setLoadingMetadata(true);
			fetch("/api/profile-analysis-metadata")
				.then((res) => res.json())
				.then((data) => {
					if (data.ok) {
						setMetadata({
							following: data.following || [],
							analyzed: data.analyzed || [],
						});
					}
				})
				.catch((err) => console.error("Failed to load metadata", err))
				.finally(() => setLoadingMetadata(false));
		}
	}, [submittedHandle]);

	const handleSelectProfile = (pHandle: string) => {
		setHandle(pHandle);
		navigate({ search: { handle: pHandle } });
	};

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setSelectedSnapshot(null); // Clear snapshot to show the stream!
		analysis.run(false);
	};

	return (
		<section className="flex min-h-screen flex-col gap-6 px-4 py-8">
			{submittedHandle ? (
				<button
					onClick={() => handleSelectProfile("")}
					className="flex items-center gap-1.5 text-[14px] text-[var(--ink-soft)] hover:text-[var(--ink)] mb-1 cursor-pointer font-medium self-start transition-all"
				>
					<ArrowLeft className="size-4" strokeWidth={1.8} />
					返回分析主屏
				</button>
			) : null}

			<header className={cx(pageHeaderClass, "border-b-0")}>
				<div className={pageHeaderRowClass}>
					<div>
						<h1 className={pageTitleClass}>Profile Analyse</h1>
						<p className={pageSubtitleClass}>
							{submittedHandle
								? formatProfileAnalysisCounts(analysis.context)
								: "Analyze Twitter profiles and view discussion thread insights"}
						</p>
					</div>

					{/* 💡 Refresh and Language actions only visible on "用户画像" Page (when handle is submitted) */}
					{submittedHandle ? (
						<div className={pageHeaderActionsClass}>
							{/* Language Switcher Dropdown (scoped to this analysis session only) */}
							<select
								className={`${secondaryButtonClass} cursor-pointer bg-[var(--bg)] pr-8 appearance-none bg-no-repeat bg-[right_12px_center] text-[14px] font-bold`}
								style={{
									backgroundImage: `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3E%3C/svg%3E")`,
									backgroundSize: "1.25rem",
								}}
								value={language}
								onChange={(e) => setLanguage(e.target.value)}
							>
								<option value="zh-CN">简体中文</option>
								<option value="en">English</option>
							</select>

							{/* Refresh or Analyse action button */}
							<button
								className={snapshots.length > 0 ? secondaryButtonClass : primaryButtonClass}
								disabled={analysis.loading}
								onClick={() => {
									setSelectedSnapshot(null);
									analysis.run(true);
								}}
								type="button"
							>
								{snapshots.length > 0 ? (
									<>
										<RefreshCw className="size-4" strokeWidth={1.8} />
										Refresh
									</>
								) : (
									<>
										<Sparkles className="size-4" />
										Analyse
									</>
								)}
							</button>
						</div>
					) : null}
				</div>

				{/* 💡 Search input form only visible on Analyse landing page */}
				{!submittedHandle && (
					<form
						className="mt-5 flex flex-col gap-3 sm:flex-row"
						onSubmit={submit}
					>
						<label className={cx(searchFieldShellClass, "min-w-0 flex-1")}>
							<Search className={searchFieldIconClass} strokeWidth={1.8} />
							<input
								className={searchFieldInputClass}
								onChange={(event) => setHandle(event.target.value)}
								placeholder="handle"
								value={handle}
							/>
						</label>
						<button
							className={primaryButtonClass}
							disabled={!submittedHandle || analysis.loading}
							type="submit"
						>
							{analysis.loading ? (
								<Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
							) : (
								<UserSearch className="size-4" strokeWidth={1.8} />
							)}
							Analyse
						</button>
					</form>
				)}
			</header>

			{!submittedHandle ? (
				<div className="flex flex-col gap-8 mt-4">
					{/* Section 1: Analyzed Profiles */}
					<div className="flex flex-col gap-3">
						<h2 className="text-[16px] font-bold text-[var(--ink)] flex items-center gap-2 border-b border-[var(--line)] pb-2">
							<UserSearch className="size-4 text-[var(--brand)]" />
							历史分析记录 ({metadata?.analyzed.length || 0})
						</h2>
						{loadingMetadata ? (
							<div className="flex items-center gap-2 text-[14px] text-[var(--ink-soft)] py-4">
								<Loader2 className="size-4 animate-spin" />
								<span>加载中...</span>
							</div>
						) : metadata?.analyzed && metadata.analyzed.length > 0 ? (
							<div className="max-h-[350px] overflow-y-auto pr-1 scrollbar-thin">
								<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
									{metadata.analyzed.map((profile) => (
										<div
											key={profile.id}
											onClick={() => handleSelectProfile(profile.handle)}
											className="flex flex-col items-center text-center p-3 rounded-lg border border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--bg-active)] cursor-pointer transition-all min-w-0 h-[105px] justify-center"
										>
											<AvatarChip
												name={profile.displayName || profile.handle}
												avatarUrl={profile.avatarUrl ?? undefined}
												hue={profile.avatarHue ?? stableHue(profile.handle)}
												profileId={profile.id}
												size="default"
											/>
											<div className="min-w-0 w-full text-center leading-tight mt-1.5">
												<div className="font-bold text-[12px] text-[var(--ink)] truncate w-full">
													{profile.displayName || profile.handle}
												</div>
												<div className="text-[10px] text-[var(--ink-soft)] truncate w-full mt-0.5">
													{profile.lastAnalyzedAt ? new Date(profile.lastAnalyzedAt).toLocaleDateString() : ""}
												</div>
											</div>
										</div>
									))}
								</div>
							</div>
						) : (
							<div className="text-[14px] text-[var(--ink-soft)] py-6 rounded-lg border border-dashed border-[var(--line)] bg-[var(--bg-active)]/50 text-center">
								暂无历史分析记录。
							</div>
						)}
					</div>

					{/* Section 2: Following List */}
					<div className="flex flex-col gap-3">
						<div className="flex items-center justify-between border-b border-[var(--line)] pb-2">
							<h2 className="text-[16px] font-bold text-[var(--ink)] flex items-center gap-2">
								<UserSearch className="size-4 text-[var(--brand)]" />
								我的关注对象 ({metadata?.following.length || 0})
							</h2>
							<SyncNowButton
								accounts={accounts}
								kind="following"
								label="同步关注"
								onSynced={() => {
									// Trigger reloading metadata list
									fetch("/api/profile-analysis-metadata")
										.then((res) => res.json())
										.then((data) => {
											if (data.ok) {
												setMetadata({
													following: data.following || [],
													analyzed: data.analyzed || [],
												});
											}
										});
								}}
							/>
						</div>
						{loadingMetadata ? (
							<div className="flex items-center gap-2 text-[14px] text-[var(--ink-soft)] py-4">
								<Loader2 className="size-4 animate-spin" />
								<span>加载中...</span>
							</div>
						) : metadata?.following && metadata.following.length > 0 ? (
							<div className="max-h-[500px] overflow-y-auto pr-1 scrollbar-thin">
								<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
									{metadata.following.map((profile) => (
										<div
											key={profile.id}
											onClick={() => handleSelectProfile(profile.handle)}
											className="flex flex-col items-center text-center p-3 rounded-lg border border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--bg-active)] cursor-pointer transition-all min-w-0 h-[105px] justify-center"
										>
											<AvatarChip
												name={profile.displayName || profile.handle}
												avatarUrl={profile.avatarUrl ?? undefined}
												hue={profile.avatarHue ?? stableHue(profile.handle)}
												profileId={profile.id}
												size="default"
											/>
											<div className="min-w-0 w-full text-center leading-tight mt-1.5">
												<div className="font-bold text-[12px] text-[var(--ink)] truncate w-full">
													{profile.displayName || profile.handle}
												</div>
												<div className="text-[10px] text-[var(--ink-soft)] truncate w-full mt-0.5 text-ellipsis">
													@{profile.handle}
												</div>
											</div>
										</div>
									))}
								</div>
							</div>
						) : (
							<div className="text-[14px] text-[var(--ink-soft)] py-6 rounded-lg border border-dashed border-[var(--line)] bg-[var(--bg-active)]/50 text-center">
								暂无关注对象。请点击右侧同步按钮导入。
							</div>
						)}
					</div>
				</div>
			) : (
				/* 💡 "用户画像" Detail Page View */
				<div className="flex flex-col gap-5">
					{/* Twitter/X Style Profile Header Card */}
					<div className="border border-[var(--line)] rounded-xl overflow-hidden bg-[var(--panel)] shadow-sm">
						{/* Cover Strip */}
						<div
							className="h-24 sm:h-28 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--bg-active)_68%,var(--accent)_32%),color-mix(in_srgb,var(--bg)_70%,var(--accent)_30%))]"
							data-testid="profile-cover"
						/>
						
						{/* Profile Info Details Area */}
						<div className="px-4 pb-4">
							<div className="flex items-start justify-between gap-3 -mt-6 sm:-mt-8">
								<div className="flex min-w-0 items-start gap-3">
									{/* Overlapping Avatar with White Ring */}
									<span className="inline-grid rounded-full ring-4 ring-[var(--panel)]">
										<AvatarChip
											name={profileInfo?.displayName || profileInfo?.handle || submittedHandle}
											avatarUrl={profileInfo?.avatarUrl ?? undefined}
											hue={profileInfo?.avatarHue ?? stableHue(profileInfo?.handle || submittedHandle)}
											profileId={profileInfo?.id}
											size="large"
										/>
									</span>
									
									{/* User Name & @id Handle Stack */}
									<div className="min-w-0 pt-7 sm:pt-9">
										<h1 className="m-0 text-[18px] sm:text-[20px] font-bold text-[var(--ink)] leading-snug truncate">
											{profileInfo?.displayName || profileInfo?.handle || submittedHandle}
										</h1>
										<div className="text-[13px] sm:text-[14px] text-[var(--ink-soft)] leading-normal truncate mt-0.5">
											@{profileInfo?.handle || submittedHandle}
										</div>
									</div>
								</div>

								{/* Right Side Actions / Dropdowns */}
								<div className="mt-8 sm:mt-10 flex shrink-0 items-center gap-2">
									<span className="text-[11px] uppercase tracking-wider font-semibold text-[var(--brand)] bg-[var(--brand-soft)]/20 px-2.5 py-1 rounded-full">
										用户画像分析
									</span>

									{/* Snapshot selector dropdown */}
									{snapshots.length > 0 ? (
										<select
											className={`${secondaryButtonClass} cursor-pointer bg-[var(--bg)] pr-8 appearance-none bg-no-repeat bg-[right_12px_center] text-[13px] sm:text-[14px] font-bold`}
											style={{
												backgroundImage: `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3E%3C/svg%3E")`,
												backgroundSize: "1.25rem",
											}}
											value={selectedSnapshot ? snapshots.indexOf(selectedSnapshot).toString() : "current"}
											onChange={(e) => {
												const val = e.target.value;
												if (val === "current") {
													setSelectedSnapshot(null);
												} else {
													const index = parseInt(val, 10);
													if (!isNaN(index) && snapshots[index]) {
														setSelectedSnapshot(snapshots[index]);
													}
												}
											}}
										>
											<option value="current">最新实时分析 (Current)</option>
											{snapshots.map((snap, i) => (
												<option key={snap.cacheKey} value={i.toString()}>
													历史快照: {new Date(snap.updatedAt).toLocaleDateString()}
												</option>
											))}
										</select>
									) : null}
								</div>
							</div>
						</div>
					</div>

					{/* Profile Analysis Status Line (shows loading status, etc.) */}
					{!selectedSnapshot && <ProfileAnalysisStatusLine analysis={analysis} className="mt-1" />}

					{/* Error copy */}
					{!selectedSnapshot && analysis.error ? (
						<div className="rounded-[8px] border border-red-500/20 bg-red-500/5 p-4 text-[14px] text-red-500">
							{analysis.error}
						</div>
					) : null}

					{/* Report Content */}
					{selectedSnapshot ? (
						<div className="flex flex-col gap-4">
							<div className="flex items-center gap-2 rounded-lg border border-[var(--brand)]/30 bg-[var(--brand-soft)]/20 px-4 py-2 text-[13px] text-[var(--brand)]">
								<Sparkles className="size-4 shrink-0" strokeWidth={1.8} />
								<span className="font-medium">
									正在查看历史快照报告（生成于 {new Date(selectedSnapshot.updatedAt).toLocaleString()} · 模型: {selectedSnapshot.model.split("/").pop()}）
								</span>
								<button
									className="ml-auto text-[12px] font-bold underline cursor-pointer hover:opacity-80"
									onClick={() => setSelectedSnapshot(null)}
								>
									返回最新分析
								</button>
							</div>
							<div className="max-w-3xl">
								<MarkdownViewer
									context={analysis.context}
									markdown={stripMarkdownHeader(selectedSnapshot.markdown, submittedHandle)}
								/>
							</div>
						</div>
					) : snapshots.length === 0 && !analysis.loading && !analysis.markdown ? (
						/* 💡 Beautiful Consent Placeholder for Un-analyzed user */
						<div className="flex flex-col items-center justify-center text-center p-12 max-w-xl mx-auto mt-12 rounded-xl border border-dashed border-[var(--line)] bg-[var(--panel)] gap-4">
							<div className="p-3 bg-[var(--brand-soft)]/20 rounded-full text-[var(--brand)]">
								<UserSearch className="size-8" strokeWidth={1.5} />
							</div>
							<h3 className="text-[16px] font-bold text-[var(--ink)]">该用户尚未进行过画像分析</h3>
							<p className="text-[13px] text-[var(--ink-soft)] max-w-sm leading-relaxed">
								当前系统未有该用户的有效分析信息。你可以选定右上角的语言，然后点击 <strong>Analyse</strong> 按钮即刻启动 AI 抓取与画像生成。
							</p>
							<button
								onClick={() => {
									setSelectedSnapshot(null);
									analysis.run(true);
								}}
								className={cx(primaryButtonClass, "mt-2 px-6")}
							>
								<Sparkles className="size-4" />
								生成画像分析 (Analyse)
							</button>
						</div>
					) : (
						<>
							{analysis.markdown ? (
								<div className="max-w-3xl">
									<MarkdownViewer
										context={analysis.context}
										markdown={stripMarkdownHeader(analysis.markdown, submittedHandle)}
									/>
								</div>
							) : (
								!analysis.loading && (
									<div className="rounded-[8px] border border-[var(--line)] bg-[var(--panel)] p-6 text-[14px] text-[var(--ink-soft)]">
										Preparing @{submittedHandle}.
									</div>
								)
							)}
						</>
					)}
				</div>
			)}
		</section>
	);
}
