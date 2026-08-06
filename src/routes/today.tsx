import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	FileDown,
	Loader2,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DigestArchiveCalendarPicker } from "#/components/DigestArchiveCalendarPicker";
import { DigestArchiveWeekPicker } from "#/components/DigestArchiveWeekPicker";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { useBirdAvailable } from "#/components/useBirdAvailable";
import { useDigestArchiveStatus } from "#/components/useDigestArchiveStatus";
import { usePeriodDigestMetadata } from "#/components/usePeriodDigestMetadata";
import { useReadOnlyDigest } from "#/components/useReadOnlyDigest";
import type {
	PeriodDigestContentSource,
	PeriodDigestContext,
	PeriodDigestRunResult,
} from "#/lib/period-digest";
import { applyPeriodDigestIdentityParams } from "#/lib/period-digest-url";
import type { ProfileRecord } from "#/lib/types";
import {
	hydrateProfileHandles,
	normalizeProfileHydrationHandle as normalizeHandle,
} from "#/lib/profile-hydration-client";
import {
	type PeriodRouteSearch,
	type RouteSearchChange,
	type TodayRouteSearch,
	validateTodaySearch,
} from "#/lib/route-search";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	secondaryButtonClass,
	segmentAccentActiveClass,
	segmentClass,
	segmentedClass,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
} from "#/lib/ui";

export const Route = createFileRoute("/today")({
	component: TodayRoute,
	validateSearch: validateTodaySearch,
});

type PeriodOption = PeriodRouteSearch;
const PROFILE_HYDRATION_LIMIT = 12;
const PROFILE_HYDRATION_DELAY_MS = 300;

const periods: Array<{ value: PeriodOption; label: string }> = [
	{ value: "today", label: "Today" },
	{ value: "24h", label: "24h" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "week", label: "Week" },
];

const CONTENT_SOURCES: Array<{
	value: PeriodDigestContentSource;
	label: string;
}> = [
	{ value: "all", label: "All" },
	{ value: "for_you", label: "For You" },
	{ value: "following", label: "Following" },
];

function periodLabel(period: PeriodOption) {
	return periods.find((item) => item.value === period)?.label ?? "Digest";
}

function exportCurrentDigestPdf(title: string) {
	const previousTitle = document.title;
	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		document.title = previousTitle;
		window.removeEventListener("afterprint", cleanup);
	};

	document.title = title;
	window.addEventListener("afterprint", cleanup, { once: true });
	window.setTimeout(cleanup, 3000);
	window.print();
}

function digestUrl(
	period: PeriodOption,
	contentSource: PeriodDigestContentSource,
) {
	const url = new URL("/api/period-digest", window.location.origin);
	applyPeriodDigestIdentityParams(url, period, false, contentSource);
	url.searchParams.set("refresh", "true");
	return url;
}

function formatCounts(context: PeriodDigestContext | null) {
	if (!context) return "Local Twitter memory, summarized as it streams.";
	const counts = context.counts;
	return [
		`${String(counts.home)} home`,
		`${String(counts.mentions)} mentions`,
		`${String(counts.links)} links`,
		context.includeDms ? `${String(counts.dms)} DMs` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function collectProfilesForHydration(result: PeriodDigestRunResult) {
	const handles = new Set<string>();
	const tweetIds = new Set<string>();
	for (const id of result.digest.sourceTweetIds) tweetIds.add(id);
	for (const topic of result.digest.keyTopics) {
		for (const id of topic.tweetIds) tweetIds.add(id);
	}
	for (const link of result.digest.notableLinks) {
		for (const id of link.sourceTweetIds) tweetIds.add(id);
	}
	for (const item of result.digest.actionItems) {
		if (item.tweetId) tweetIds.add(item.tweetId);
	}

	const tweetsById = new Map(
		result.context.tweets.flatMap((tweet) => [
			[tweet.id, tweet],
			[`tweet_${tweet.id}`, tweet],
		]),
	);
	for (const id of tweetIds) {
		const tweet = tweetsById.get(id);
		if (!tweet) continue;
		const handle = normalizeHandle(tweet.author);
		if (handle) handles.add(handle);
	}

	for (const tweet of result.context.tweets) {
		const handle = normalizeHandle(tweet.author);
		if (handle) handles.add(handle);
	}
	return [...handles];
}

function applyHydratedProfilesToContext(
	context: PeriodDigestContext,
	profilesByHandle: Map<string, ProfileRecord>,
) {
	let changed = false;
	const tweets = context.tweets.map((tweet) => {
		const profile = profilesByHandle.get(normalizeHandle(tweet.author));
		if (!profile || profile === tweet.authorProfile) return tweet;
		changed = true;
		return {
			...tweet,
			author: profile.handle,
			name: profile.displayName,
			authorProfile: profile,
		};
	});
	return changed ? { ...context, tweets } : context;
}

function applyHydratedProfilesToResult(
	result: PeriodDigestRunResult,
	profiles: ProfileRecord[],
) {
	const profilesByHandle = new Map(
		profiles.map((profile) => [normalizeHandle(profile.handle), profile]),
	);
	if (profilesByHandle.size === 0) return result;
	const context = applyHydratedProfilesToContext(
		result.context,
		profilesByHandle,
	);
	return context === result.context ? result : { ...result, context };
}

function useCurrentDigest(
	period: PeriodOption,
	contentSource: PeriodDigestContentSource,
	enabled: boolean,
) {
	const queryClient = useQueryClient();
	const [hydratedResult, setHydratedResult] =
		useState<PeriodDigestRunResult | null>(null);
	const metadata = usePeriodDigestMetadata({
		period,
		contentSource,
		enabled,
	});
	const refreshMutation = useMutation({
		mutationFn: async () => {
			const response = await fetch(digestUrl(period, contentSource), {
				cache: "no-store",
			});
			if (!response.ok) {
				throw new Error(`Digest request failed (${String(response.status)})`);
			}
			const body = await response.text();
			for (const line of body.split("\n")) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as { type?: string; error?: string };
					if (event.type === "error") {
						throw new Error(event.error || "Digest request failed");
					}
				} catch (error) {
					if (error instanceof SyntaxError) continue;
					throw error;
				}
			}
		},
		onSuccess: () => {
			void metadata.refetch();
		},
	});
	const sourceResult = metadata.result;
	const result =
		hydratedResult && hydratedResult.updatedAt === sourceResult?.updatedAt
			? hydratedResult
			: sourceResult;

	useEffect(() => {
		if (!result) return;
		const handles = collectProfilesForHydration(result);
		if (handles.length === 0) return;

		let active = true;
		let idleId: number | null = null;
		const runHydration = () => {
			hydrateProfileHandles(queryClient, handles, {
				limit: PROFILE_HYDRATION_LIMIT,
			})
				.then((response) => {
					if (!active) return;
					const { profiles } = response;
					if (profiles.length === 0) return;
					setHydratedResult(applyHydratedProfilesToResult(result, profiles));
				})
				.catch((error: unknown) => {
					if (!active) return;
					console.warn("Profile hydration failed", error);
				});
		};
		const timer = window.setTimeout(() => {
			if ("requestIdleCallback" in window) {
				idleId = window.requestIdleCallback(runHydration, { timeout: 2500 });
			} else {
				runHydration();
			}
		}, PROFILE_HYDRATION_DELAY_MS);

		return () => {
			active = false;
			window.clearTimeout(timer);
			if (idleId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleId);
			}
		};
	}, [queryClient, result?.updatedAt]);

	const runError = metadata.runState as {
		phase?: string;
		error?: string;
	} | null;
	const error =
		refreshMutation.error ??
		metadata.error ??
		(runError?.phase === "failed" && runError.error
			? new Error(runError.error)
			: null);
	const status = metadata.isGenerating
		? metadata.activeStatus?.detail
			? `${metadata.activeStatus.label} · ${metadata.activeStatus.detail}`
			: (metadata.activeStatus?.label ?? "Updating in background")
		: metadata.isStale
			? "Outdated · waiting for background refresh"
			: "Ready";

	return {
		error,
		isGenerating: metadata.isGenerating,
		loading: metadata.isLoading && !result,
		markdown: result?.markdown ?? "",
		refresh: () => refreshMutation.mutate(),
		refreshing: refreshMutation.isPending,
		result,
		status,
	};
}

function TodayRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<TodayRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

export function TodayRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: TodayRouteSearch;
	onSearchChange?: RouteSearchChange<TodayRouteSearch>;
} = {}) {
	const [localSearch, setLocalSearch] = useState(() => validateTodaySearch({}));
	const searchState = controlledSearch ?? localSearch;
	const updateSearch: RouteSearchChange<TodayRouteSearch> = (next, options) =>
		onSearchChange ? onSearchChange(next, options) : setLocalSearch(next);
	const { period, contentSource, archiveDate } = searchState;
	const birdAvailable = useBirdAvailable();
	// For You requires bird; fall back to the safe "all" default when it
	// isn't available, regardless of what the URL/local state currently says.
	const effectiveContentSource =
		contentSource === "for_you" && !birdAvailable ? "all" : contentSource;
	// Yesterday/Week are scheduled-only (no manual refresh, see the design
	// discussion in issue #30/PR #31): their "current" view is just "the
	// latest archived date," and picking an explicit historical date reads
	// the same way — there's no separate live-generation path for either.
	const isArchivedPeriod = period === "yesterday" || period === "week";
	const archiveStatus = useDigestArchiveStatus();
	const archiveRunning = archiveStatus.runningPeriods.has(period);
	const activeArchiveRun = archiveStatus.activeRuns.get(period);
	const current = useCurrentDigest(
		period,
		effectiveContentSource,
		!isArchivedPeriod,
	);
	const archived = useReadOnlyDigest({
		period,
		contentSource: effectiveContentSource,
		archiveDate,
		enabled: isArchivedPeriod,
		running: archiveRunning,
		activeRunDate: activeArchiveRun?.runDate,
	});
	const useArchivedResult = isArchivedPeriod;
	const archiveBusy = archived.activeRunInProgress;
	const context = useArchivedResult
		? archived.context
		: (current.result?.context ?? null);
	const markdown = useArchivedResult ? archived.markdown : current.markdown;
	const result = useArchivedResult ? archived.result : current.result;
	const loading = useArchivedResult ? archived.loading : current.loading;
	const digestError = useArchivedResult
		? archived.error
		: current.error instanceof Error
			? current.error.message
			: current.error
				? String(current.error)
				: null;
	const activeSourceStates = activeArchiveRun
		? Object.values(activeArchiveRun.sources)
		: [];
	const completedScheduledSources = activeSourceStates.length
		? activeSourceStates.filter((source) => source.state === "completed").length
		: archived.completedSources;
	const status = useArchivedResult
		? archiveBusy
			? `Generating scheduled digest ${String(completedScheduledSources)}/${String(activeArchiveRun?.totalSources ?? 3)}`
			: "Loading archive"
		: current.status;
	const latestArchiveRun = archiveStatus.lastRuns.get(period);
	const latestSourceRun = latestArchiveRun?.sources[effectiveContentSource];
	const showingLatestArchiveRun = archiveDate
		? latestArchiveRun?.runDate === archiveDate
		: !archived.effectiveDate ||
			latestArchiveRun?.runDate === archived.effectiveDate;
	const scheduledRunError =
		!result && showingLatestArchiveRun
			? latestSourceRun?.state === "failed"
				? latestSourceRun.error || "unknown error"
				: latestArchiveRun?.error || null
			: null;
	useEffect(() => {
		const root = document.documentElement;
		root.classList.add("today-pdf-route");
		return () => root.classList.remove("today-pdf-route");
	}, []);
	const sourceLabel = useMemo(
		() => formatCounts(result?.context ?? context),
		[context, result],
	);
	const digestLabel =
		result?.context.window.label ??
		context?.window.label ??
		periodLabel(period);
	const canExportPdf = Boolean(result?.markdown.trim());
	const exportTitle = `BirdClaw ${digestLabel} digest`;
	const exportUpdatedAt = result
		? new Date(result.updatedAt).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;
	const displayError = digestError;
	const retry = isArchivedPeriod ? archived.retry : current.refresh;
	const handleExportPdf = useCallback(() => {
		if (!canExportPdf) return;
		exportCurrentDigestPdf(exportTitle);
	}, [canExportPdf, exportTitle]);

	return (
		<div className="today-pdf-root flex min-h-screen flex-col">
			<header className={cx("today-pdf-header", pageHeaderClass)}>
				<div className={pageHeaderRowClass}>
					<div className="min-w-0">
						<h1 className={pageTitleClass}>What happened</h1>
						<p className={pageSubtitleClass}>{sourceLabel}</p>
					</div>
					<div className={cx("today-screen-only", pageHeaderActionsClass)}>
						{canExportPdf ? (
							<button
								type="button"
								className={secondaryButtonClass}
								onClick={handleExportPdf}
							>
								<FileDown className="size-4" aria-hidden="true" />
								Export PDF
							</button>
						) : null}
						{isArchivedPeriod ? null : (
							<button
								type="button"
								className={secondaryButtonClass}
								onClick={current.refresh}
								disabled={current.isGenerating || current.refreshing}
							>
								<RefreshCw
									className={cx(
										"size-4",
										(current.isGenerating || current.refreshing) &&
											"animate-spin",
									)}
									aria-hidden="true"
								/>
								Refresh
							</button>
						)}
					</div>
				</div>
				<div className="today-pdf-meta" aria-hidden="true">
					<span>{digestLabel}</span>
					<span>·</span>
					<span>Sources: {sourceLabel}</span>
					{exportUpdatedAt ? (
						<>
							<span>·</span>
							<span>Generated {exportUpdatedAt}</span>
						</>
					) : null}
				</div>
				<div className="today-screen-only">
					<div className={tabStripClass} aria-label="Digest content">
						{CONTENT_SOURCES.filter(
							(item) => item.value !== "for_you" || birdAvailable,
						).map((item) => {
							const active = effectiveContentSource === item.value;
							return (
								<button
									key={item.value}
									type="button"
									aria-pressed={active}
									className={cx(tabButtonClass, active && tabButtonActiveClass)}
									onClick={() =>
										updateSearch({ ...searchState, contentSource: item.value })
									}
								>
									<span className="relative inline-flex flex-col items-center justify-center py-1">
										{item.label}
										{active ? (
											<span className={tabButtonIndicatorClass} />
										) : null}
									</span>
								</button>
							);
						})}
					</div>
				</div>
				<div className="today-screen-only flex flex-wrap items-center gap-2 px-4 pb-3">
					<div className={segmentedClass} aria-label="Digest period">
						{periods.map((item) => (
							<button
								key={item.value}
								type="button"
								aria-pressed={period === item.value}
								className={cx(
									segmentClass,
									period === item.value && segmentAccentActiveClass,
								)}
								onClick={() =>
									updateSearch({
										...searchState,
										period: item.value,
										archiveDate: "",
									})
								}
							>
								{item.label}
							</button>
						))}
					</div>
					{period === "yesterday" ? (
						<DigestArchiveCalendarPicker
							dates={archived.dates}
							value={archiveDate}
							onChange={(date) =>
								updateSearch({ ...searchState, archiveDate: date })
							}
						/>
					) : null}
					{period === "week" ? (
						<DigestArchiveWeekPicker
							dates={archived.dates}
							value={archiveDate}
							onChange={(date) =>
								updateSearch({ ...searchState, archiveDate: date })
							}
						/>
					) : null}
				</div>
			</header>

			{displayError ? (
				<div
					className={cx(
						errorCopyClass,
						"flex items-center justify-between gap-3",
					)}
					role="alert"
				>
					<span>{displayError}</span>
					<button
						className="shrink-0 font-semibold underline underline-offset-2"
						onClick={retry}
						type="button"
					>
						Retry
					</button>
				</div>
			) : null}

			<div className="today-screen-only flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--line)] px-4 py-2 text-[13px] text-[var(--ink-soft)]">
				<span className="inline-flex items-center gap-1">
					{loading || archiveBusy || current.isGenerating ? (
						<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					) : markdown ? (
						<CheckCircle2 className="size-4" aria-hidden="true" />
					) : (
						<Sparkles className="size-4" aria-hidden="true" />
					)}
					{archiveBusy
						? status
						: current.isGenerating
							? current.status
							: loading
								? status
								: result
									? `${result.cached ? "Cached" : "Ready"} · ${result.context.window.label}`
									: digestError
										? "Digest failed"
										: "Ready"}
				</span>
				{result && exportUpdatedAt ? (
					<time aria-label="Generated at" dateTime={result.updatedAt}>
						Generated {exportUpdatedAt}
					</time>
				) : null}
			</div>

			{markdown ? (
				<MarkdownViewer
					context={result?.context ?? context}
					markdown={markdown}
				/>
			) : (
				<div className="px-4 py-5 text-[14px] text-[var(--ink-soft)]">
					{archiveBusy && archived.sourcePending
						? "This source is still being generated."
						: current.isGenerating
							? "Generating the first current digest in the background."
							: loading
								? status
								: digestError
									? isArchivedPeriod
										? "No digest was generated. Retry to load the archive again."
										: "No digest was generated. Retry to start a new run."
									: scheduledRunError
										? `Scheduled digest failed: ${scheduledRunError}`
										: useArchivedResult
											? archived.neverArchived
												? `This period hasn't run on a schedule yet. It will generate automatically at the next scheduled time.`
												: `No archived ${effectiveContentSource === "all" ? "" : `${effectiveContentSource} `}digest for this date. Try a different content-source tab.`
											: "Waiting for the first tokens..."}
				</div>
			)}
		</div>
	);
}
