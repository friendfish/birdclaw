import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	FileDown,
	Loader2,
	RefreshCw,
	Save as SaveIcon,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { DigestArchiveCalendarPicker } from "#/components/DigestArchiveCalendarPicker";
import { DigestArchiveWeekPicker } from "#/components/DigestArchiveWeekPicker";
import { MarkdownViewer } from "#/components/MarkdownViewer";
import { useBirdAvailable } from "#/components/useBirdAvailable";
import { useDigestArchiveStatus } from "#/components/useDigestArchiveStatus";
import { useNdjsonRun } from "#/components/useNdjsonRun";
import { usePeriodDigestMetadata } from "#/components/usePeriodDigestMetadata";
import { useReadOnlyDigest } from "#/components/useReadOnlyDigest";
import {
	isTerminalStreamEvent,
	periodDigestStreamEventSchema,
} from "#/lib/client-stream-contracts";
import { fetchJson } from "#/lib/api-client";
import type {
	PeriodDigestContentSource,
	PeriodDigestContext,
	PeriodDigestRunResult,
	PeriodDigestStreamEvent,
} from "#/lib/period-digest";
import { applyPeriodDigestIdentityParams } from "#/lib/period-digest-url";
import { queryKeys } from "#/lib/query-client";
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
const DIGEST_STATUS_MESSAGES = {
	524: "Digest startup timed out at Cloudflare (524). Retry to open a new stream.",
} as const;

const digestArchiveSaveResponseSchema = z.object({
	ok: z.literal(true),
	period: z.enum(["today", "24h"]),
	contentSource: z.enum(["all", "for_you", "following"]),
	generatedAt: z.string(),
	savedAt: z.string(),
});

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
	includeDms: boolean,
	contentSource: PeriodDigestContentSource,
	refresh: boolean,
) {
	const url = new URL("/api/period-digest", window.location.origin);
	applyPeriodDigestIdentityParams(url, period, includeDms, contentSource);
	if (refresh) {
		url.searchParams.set("refresh", "true");
	}
	return url;
}

function digestStreamError(cause: unknown, phase: string) {
	const message = cause instanceof Error ? cause.message : String(cause);
	if (
		cause instanceof TypeError &&
		/network error|failed to fetch|load failed/i.test(message)
	) {
		return `Digest connection was interrupted while ${phase.toLowerCase()}. Retry to continue.`;
	}
	if (cause instanceof SyntaxError) {
		return `Digest stream returned invalid data while ${phase.toLowerCase()}. Retry to continue.`;
	}
	return message || "Digest failed";
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

function useDigestStream(
	period: PeriodOption,
	includeDms: boolean,
	contentSource: PeriodDigestContentSource,
	enabled: boolean,
	manualIdentity: string,
	onManualStart: (identity: string) => void,
	onManualResult: (identity: string, updatedAt: string) => void,
) {
	const queryClient = useQueryClient();
	const [markdown, setMarkdown] = useState("");
	const [context, setContext] = useState<PeriodDigestContext | null>(null);
	const [result, setResult] = useState<PeriodDigestRunResult | null>(null);
	const [status, setStatus] = useState("Starting digest");
	const [isWatching, setIsWatching] = useState(false);
	const latestStatusRef = useRef("Starting digest");
	const startedRef = useRef(false);
	const pendingManualIdentityRef = useRef<string | null>(null);
	const metadata = usePeriodDigestMetadata({
		period,
		includeDms,
		contentSource,
		enabled,
	});

	const onStart = useCallback(() => {
		setMarkdown("");
		setContext(null);
		setResult(null);
		setStatus("Starting digest");
		latestStatusRef.current = "Starting digest";
	}, []);
	const request = useCallback(
		(signal: AbortSignal, refresh: boolean) =>
			fetch(digestUrl(period, includeDms, contentSource, refresh), {
				cache: "no-store",
				signal,
			}),
		[contentSource, includeDms, period],
	);
	const onEvent = useCallback(
		(event: PeriodDigestStreamEvent) => {
			if (event.type === "status") {
				latestStatusRef.current = event.detail
					? `${event.label} · ${event.detail}`
					: event.label;
				setStatus(latestStatusRef.current);
			} else if (event.type === "start") setContext(event.context);
			else if (event.type === "delta") {
				latestStatusRef.current = "Streaming AI summary";
				setStatus(latestStatusRef.current);
				setMarkdown((current) => current + event.delta);
			} else if (event.type === "done") {
				setResult(event.result);
				setContext(event.result.context);
				setMarkdown(event.result.markdown);
				setStatus(event.result.cached ? "Loaded cached report" : "Ready");
				const completedManualIdentity = pendingManualIdentityRef.current;
				pendingManualIdentityRef.current = null;
				if (completedManualIdentity) {
					onManualResult(completedManualIdentity, event.result.updatedAt);
				}
			} else if (event.type === "error") {
				throw new Error(event.error);
			}
		},
		[onManualResult],
	);
	const onError = useCallback(() => {
		pendingManualIdentityRef.current = null;
		setStatus("Digest failed");
	}, []);
	const prematureEofError = useCallback(
		() =>
			new Error(
				`Digest connection closed while ${latestStatusRef.current.toLowerCase()}. Retry to continue.`,
			),
		[],
	);
	const formatError = useCallback(
		(cause: unknown) => digestStreamError(cause, latestStatusRef.current),
		[],
	);
	const {
		error,
		loading,
		run: runStream,
	} = useNdjsonRun({
		schema: periodDigestStreamEventSchema,
		request,
		onStart,
		onEvent,
		onError,
		isTerminal: isTerminalStreamEvent,
		errorLabel: "Digest request failed",
		emptyBodyMessage: "Digest request failed: empty response body",
		prematureEofError,
		formatError,
		statusMessages: DIGEST_STATUS_MESSAGES,
	});
	const run = useCallback(
		(refresh: boolean) => {
			pendingManualIdentityRef.current = refresh ? manualIdentity : null;
			if (refresh) onManualStart(manualIdentity);
			runStream(refresh);
		},
		[manualIdentity, onManualStart, runStream],
	);

	useEffect(() => {
		startedRef.current = false;
		setIsWatching(false);
	}, [period, includeDms, contentSource, enabled]);

	useEffect(() => {
		// Yesterday/Week are scheduled-only (see the archived viewMode branch
		// in TodayRouteView) — this hook must not fetch/generate anything
		// while they're the active period.
		if (!enabled) return;
		// Wait for the first metadata check before deciding anything — this is
		// what lets a generation started before the user navigated away keep
		// being watched instead of restarted from scratch (the server keeps it
		// running regardless; see /api/period-digest's decoupled signal).
		if (metadata.isLoading) return;

		const adoptCachedResult = (cachedResult: PeriodDigestRunResult) => {
			setResult(cachedResult);
			setContext(cachedResult.context);
			setMarkdown(cachedResult.markdown);
			setStatus(cachedResult.cached ? "Loaded cached report" : "Ready");
		};
		const showActiveStatus = () => {
			const label = metadata.activeStatus?.detail
				? `${metadata.activeStatus.label} · ${metadata.activeStatus.detail}`
				: (metadata.activeStatus?.label ?? "Generating in background");
			latestStatusRef.current = label;
			setStatus(label);
		};

		if (!startedRef.current) {
			startedRef.current = true;
			if (metadata.isGenerating) {
				setIsWatching(true);
				showActiveStatus();
				return;
			}
			if (metadata.result) {
				adoptCachedResult(metadata.result);
				return;
			}
			run(false);
			return;
		}

		if (!isWatching) return;
		if (metadata.isGenerating) {
			showActiveStatus();
			return;
		}
		setIsWatching(false);
		if (metadata.result) {
			adoptCachedResult(metadata.result);
		} else {
			// The background run we were watching finished without leaving a
			// usable result (e.g. it failed) — fall back to a normal run.
			run(false);
		}
	}, [
		enabled,
		isWatching,
		metadata.isLoading,
		metadata.isGenerating,
		metadata.result,
		metadata.activeStatus,
		run,
	]);

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
					setResult((current) =>
						current
							? applyHydratedProfilesToResult(current, profiles)
							: current,
					);
					const profilesByHandle = new Map(
						profiles.map((profile) => [
							normalizeHandle(profile.handle),
							profile,
						]),
					);
					setContext((current) =>
						current
							? applyHydratedProfilesToContext(current, profilesByHandle)
							: current,
					);
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
	}, [queryClient, result]);

	return {
		context,
		error,
		loading: loading || isWatching,
		markdown,
		result,
		run,
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
	const { period, includeDms, contentSource, archiveDate } = searchState;
	const birdAvailable = useBirdAvailable();
	// For You requires bird; fall back to the safe "all" default when it
	// isn't available, regardless of what the URL/local state currently says.
	const effectiveContentSource =
		contentSource === "for_you" && !birdAvailable ? "all" : contentSource;
	const queryClient = useQueryClient();
	const [eligibleManualResults, setEligibleManualResults] = useState<
		Map<string, string>
	>(() => new Map());
	const [savedManualResults, setSavedManualResults] = useState<
		Map<string, string>
	>(() => new Map());
	const digestIdentity = `${period}:${effectiveContentSource}:${includeDms ? "dms" : "no-dms"}`;
	const saveMutation = useMutation({
		mutationFn: (variables: {
			identity: string;
			period: "today" | "24h";
			contentSource: PeriodDigestContentSource;
			includeDms: boolean;
			expectedUpdatedAt: string;
		}) =>
			fetchJson(
				"/api/digest-archive-save",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						period: variables.period,
						contentSource: variables.contentSource,
						includeDms: variables.includeDms,
						expectedUpdatedAt: variables.expectedUpdatedAt,
					}),
				},
				digestArchiveSaveResponseSchema,
				"Failed to save digest archive",
			),
		onSuccess: (saved, variables) => {
			setEligibleManualResults((current) => {
				const next = new Map(current);
				next.delete(variables.identity);
				return next;
			});
			setSavedManualResults((current) =>
				new Map(current).set(variables.identity, saved.generatedAt),
			);
			void queryClient.invalidateQueries({
				queryKey: queryKeys.digestArchiveDates,
			});
			void queryClient.invalidateQueries({
				queryKey: queryKeys.digestArchiveEntry,
			});
		},
	});
	const handleManualStart = useCallback(
		(identity: string) => {
			saveMutation.reset();
			setEligibleManualResults((current) => {
				const next = new Map(current);
				next.delete(identity);
				return next;
			});
			setSavedManualResults((current) => {
				const next = new Map(current);
				next.delete(identity);
				return next;
			});
		},
		[saveMutation.reset],
	);
	const handleManualResult = useCallback(
		(identity: string, updatedAt: string) => {
			setEligibleManualResults((current) =>
				new Map(current).set(identity, updatedAt),
			);
		},
		[],
	);
	// Yesterday/Week are scheduled-only (no manual refresh, see the design
	// discussion in issue #30/PR #31): their "current" view is just "the
	// latest archived date," and picking an explicit historical date reads
	// the same way — there's no separate live-generation path for either.
	const isArchivedPeriod = period === "yesterday" || period === "week";
	const archiveStatus = useDigestArchiveStatus();
	const archiveRunning = archiveStatus.runningPeriods.has(period);
	const activeArchiveRun = archiveStatus.activeRuns.get(period);
	const live = useDigestStream(
		period,
		includeDms,
		effectiveContentSource,
		!isArchivedPeriod && !archiveStatus.loading && !archiveRunning,
		digestIdentity,
		handleManualStart,
		handleManualResult,
	);
	const archived = useReadOnlyDigest({
		period,
		contentSource: effectiveContentSource,
		archiveDate,
		enabled: isArchivedPeriod || archiveRunning,
		running: archiveRunning,
		activeRunDate: activeArchiveRun?.runDate,
	});
	const liveResultIsCurrent = Boolean(
		live.result &&
		(!archived.result ||
			live.result.updatedAt === archived.result.updatedAt ||
			Date.parse(live.result.updatedAt) >=
				Date.parse(archived.result.updatedAt)),
	);
	const useArchivedResult =
		isArchivedPeriod ||
		archiveRunning ||
		archived.finalizing ||
		(Boolean(archived.result) && !liveResultIsCurrent);
	const archiveBusy = archived.activeRunInProgress;
	const context = useArchivedResult ? archived.context : live.context;
	const markdown = useArchivedResult ? archived.markdown : live.markdown;
	const result = useArchivedResult ? archived.result : live.result;
	const loading = useArchivedResult
		? archived.loading
		: archiveStatus.loading || live.loading;
	const digestError = useArchivedResult ? archived.error : live.error;
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
		: live.status;
	const latestArchiveRun = archiveStatus.lastRuns.get(period);
	const latestSourceRun = latestArchiveRun?.sources[effectiveContentSource];
	const showingLatestArchiveRun = archiveDate
		? latestArchiveRun?.runDate === archiveDate
		: !archived.effectiveDate ||
			latestArchiveRun?.runDate === archived.effectiveDate;
	const scheduledSourceError =
		!result && showingLatestArchiveRun && latestSourceRun?.state === "failed"
			? latestSourceRun.error || "unknown error"
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
	const canExportPdf = Boolean(result?.markdown.trim()) && !loading;
	const exportTitle = `BirdClaw ${digestLabel} digest`;
	const exportUpdatedAt = result
		? new Date(result.updatedAt).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;
	const eligibleUpdatedAt = eligibleManualResults.get(digestIdentity);
	const savedUpdatedAt = savedManualResults.get(digestIdentity);
	const saveIsCurrent = saveMutation.variables?.identity === digestIdentity;
	const saveError =
		saveMutation.isError && saveIsCurrent
			? saveMutation.error instanceof Error
				? saveMutation.error.message
				: String(saveMutation.error)
			: null;
	const displayError = saveError ?? digestError;
	const canSave = Boolean(
		!isArchivedPeriod &&
		result &&
		result.updatedAt === eligibleUpdatedAt &&
		!loading &&
		!archiveRunning &&
		!saveMutation.isPending,
	);
	const savedCurrentResult = Boolean(
		result && result.updatedAt === savedUpdatedAt && !eligibleUpdatedAt,
	);
	const handleSave = useCallback(() => {
		if (
			!result ||
			isArchivedPeriod ||
			(period !== "today" && period !== "24h")
		) {
			return;
		}
		saveMutation.mutate({
			identity: digestIdentity,
			period,
			contentSource: effectiveContentSource,
			includeDms,
			expectedUpdatedAt: result.updatedAt,
		});
	}, [
		digestIdentity,
		effectiveContentSource,
		includeDms,
		isArchivedPeriod,
		period,
		result,
		saveMutation.mutate,
	]);
	const retry = saveError
		? handleSave
		: isArchivedPeriod
			? archived.retry
			: () => live.run(true);
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
							<>
								<button
									type="button"
									className={secondaryButtonClass}
									onClick={handleSave}
									disabled={!canSave}
								>
									{saveMutation.isPending && saveIsCurrent ? (
										<Loader2
											className="size-4 animate-spin"
											aria-hidden="true"
										/>
									) : (
										<SaveIcon className="size-4" aria-hidden="true" />
									)}
									{savedCurrentResult ? "Saved" : "Save"}
								</button>
								<button
									type="button"
									className={secondaryButtonClass}
									onClick={() => live.run(true)}
									disabled={loading || archiveStatus.runningPeriods.has(period)}
								>
									<RefreshCw
										className={cx("size-4", loading && "animate-spin")}
										aria-hidden="true"
									/>
									Refresh
								</button>
							</>
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
					{isArchivedPeriod ? null : (
						<label className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1 text-[13px] font-medium text-[var(--ink-soft)]">
							<input
								type="checkbox"
								checked={includeDms}
								onChange={(event) =>
									updateSearch({
										...searchState,
										includeDms: event.currentTarget.checked,
									})
								}
							/>
							DMs
						</label>
					)}
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
					{loading || archiveBusy ? (
						<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					) : markdown ? (
						<CheckCircle2 className="size-4" aria-hidden="true" />
					) : (
						<Sparkles className="size-4" aria-hidden="true" />
					)}
					{archiveBusy
						? status
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
						: loading
							? status
							: digestError
								? isArchivedPeriod
									? "No digest was generated. Retry to load the archive again."
									: "No digest was generated. Retry to start a new run."
								: scheduledSourceError
									? `Scheduled digest failed: ${scheduledSourceError}`
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
