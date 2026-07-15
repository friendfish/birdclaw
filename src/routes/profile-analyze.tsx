import { createFileRoute } from "@tanstack/react-router";
import { Loader2, RefreshCw, Search, UserSearch, Sparkles, ArrowLeft } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AvatarChip } from "#/components/AvatarChip";
import { MarkdownViewer } from "#/components/MarkdownViewer";
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
	const autoRunHandleRef = useRef("");
	const autoRunLangRef = useRef("");
	const runAnalysisRef = useRef(analysis.run);

	// Metadata for lists
	const [metadata, setMetadata] = useState<{
		following: any[];
		analyzed: any[];
	} | null>(null);
	const [loadingMetadata, setLoadingMetadata] = useState(false);

	// Snapshots for selected handle
	const [snapshots, setSnapshots] = useState<any[]>([]);
	const [selectedSnapshot, setSelectedSnapshot] = useState<any | null>(null);

	const displayMarkdown = useMemo(() => {
		const rawMarkdown = selectedSnapshot ? selectedSnapshot.markdown : analysis.markdown;
		if (!rawMarkdown) return "";
		const lines = rawMarkdown.split(/\r?\n/);
		if (lines[0] && lines[0].trim().startsWith("# ")) {
			return lines.slice(1).join("\n");
		}
		return rawMarkdown;
	}, [selectedSnapshot, analysis.markdown]);

	useEffect(() => {
		runAnalysisRef.current = analysis.run;
	}, [analysis.run]);

	useEffect(() => {
		const urlHandle = cleanProfileHandle(search.handle);
		setHandle(urlHandle);
		if (
			urlHandle &&
			(autoRunHandleRef.current !== urlHandle ||
				autoRunLangRef.current !== language)
		) {
			autoRunHandleRef.current = urlHandle;
			autoRunLangRef.current = language;
			runAnalysisRef.current(false, urlHandle);
		}
	}, [search.handle, language]);

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

	// Load snapshots when handle changes
	useEffect(() => {
		if (submittedHandle) {
			setSelectedSnapshot(null);
			fetch(`/api/profile-analysis-metadata?handle=${encodeURIComponent(submittedHandle)}`)
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
				.catch((err) => console.error("Failed to load snapshots", err));
		} else {
			setSnapshots([]);
			setSelectedSnapshot(null);
		}
	}, [submittedHandle]);

	const handleSelectProfile = (pHandle: string) => {
		setHandle(pHandle);
		navigate({ search: { handle: pHandle } });
	};

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
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
					<div className={pageHeaderActionsClass}>
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

						<button
							className={secondaryButtonClass}
							disabled={!submittedHandle || analysis.loading}
							onClick={() => {
								setSelectedSnapshot(null);
								analysis.run(true);
							}}
							type="button"
						>
							<RefreshCw className="size-4" strokeWidth={1.8} />
							Refresh
						</button>
					</div>
				</div>
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
								<div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
									{metadata.analyzed.map((profile) => (
										<div
											key={profile.id}
											onClick={() => handleSelectProfile(profile.handle)}
											className="flex flex-col items-center text-center p-3 rounded-lg border border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--bg-active)] cursor-pointer transition-all min-w-0 h-[105px] justify-center"
										>
											<AvatarChip
												profileId={profile.id}
												avatarUrl={profile.avatarUrl}
												name={profile.displayName || profile.handle}
												hue={profile.avatarHue}
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
						<h2 className="text-[16px] font-bold text-[var(--ink)] flex items-center gap-2 border-b border-[var(--line)] pb-2">
							<RefreshCw className="size-4 text-[var(--brand)]" />
							我的关注对象 ({metadata?.following.length || 0})
						</h2>
						{loadingMetadata ? (
							<div className="flex items-center gap-2 text-[14px] text-[var(--ink-soft)] py-4">
								<Loader2 className="size-4 animate-spin" />
								<span>加载中...</span>
							</div>
						) : metadata?.following && metadata.following.length > 0 ? (
							<div className="max-h-[550px] overflow-y-auto pr-1 scrollbar-thin">
								<div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
									{metadata.following.map((profile) => (
										<div
											key={profile.id}
											onClick={() => handleSelectProfile(profile.handle)}
											className="flex flex-col items-center text-center p-3 rounded-lg border border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--bg-active)] cursor-pointer transition-all min-w-0 h-[105px] justify-center"
										>
											<AvatarChip
												profileId={profile.id}
												avatarUrl={profile.avatarUrl}
												name={profile.displayName || profile.handle}
												hue={profile.avatarHue}
												size="default"
											/>
											<div className="min-w-0 w-full text-center leading-tight mt-1.5">
												<span className="font-bold text-[12px] text-[var(--ink)] block truncate w-full">
													{profile.displayName || profile.handle}
												</span>
												<span className="text-[10px] text-[var(--ink-soft)] block truncate w-full mt-0.5">
													@{profile.handle}
												</span>
											</div>
										</div>
									))}
								</div>
							</div>
						) : (
							<div className="text-[14px] text-[var(--ink-soft)] py-6 rounded-lg border border-dashed border-[var(--line)] bg-[var(--bg-active)]/50 text-center">
								暂无关注对象。
							</div>
						)}
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-4 mt-2">
					{/* Status line */}
					{!selectedSnapshot && <ProfileAnalysisStatusLine analysis={analysis} />}
					
					{/* Custom Profile Heading with Avatar and Dropdown */}
					{analysis.context?.profile && (
						<div className="flex items-center justify-between gap-4 border-b border-[var(--line)] pb-3 mb-2 w-full">
							<div className="flex items-center gap-3 min-w-0">
								<AvatarChip
									profileId={analysis.context.profile.id}
									avatarUrl={analysis.context.profile.avatarUrl}
									name={analysis.context.profile.displayName || submittedHandle}
									hue={analysis.context.profile.avatarHue}
									size="large"
								/>
								<h1 className="text-[20px] font-bold text-[var(--ink)] truncate">
									@{submittedHandle} 个人资料分析
								</h1>
							</div>
							
							{/* Dropdown select right-aligned */}
							{snapshots.length > 0 ? (
								<div className="shrink-0">
									<select
										className={`${secondaryButtonClass} cursor-pointer bg-[var(--bg)] pr-8 appearance-none bg-no-repeat bg-[right_12px_center] text-[14px] font-bold h-9`}
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
												历史快照: {new Date(snap.updatedAt).toLocaleDateString()} ({snap.model.split("/").pop()})
											</option>
										))}
									</select>
								</div>
							) : null}
						</div>
					)}

					{/* Snapshot notification */}
					{selectedSnapshot && (
						<div className="flex items-center gap-2 rounded-lg border border-[var(--brand)]/30 bg-[var(--brand-soft)]/20 px-4 py-2.5 text-[14px] text-[var(--brand)]">
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
					)}

					{/* Content body with stripped H1 */}
					{displayMarkdown ? (
						<div className="max-w-3xl mt-2">
							<MarkdownViewer
								context={analysis.context}
								markdown={displayMarkdown}
							/>
						</div>
					) : (
						<div className="rounded-[8px] border border-[var(--line)] bg-[var(--panel)] p-6 text-[14px] text-[var(--ink-soft)]">
							{analysis.error ? (
								<div className="text-[var(--alert)]">{analysis.error}</div>
							) : (
								"No profile selected."
							)}
						</div>
					)}
				</div>
			)}
		</section>
	);
}
