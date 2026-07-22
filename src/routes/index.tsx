import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { TimelineRouteFrame } from "#/components/TimelineRouteFrame";
import { fetchJson } from "#/lib/api-client";
import type { QueryEnvelope } from "#/lib/api-contracts";
import { liveDataSourcesResponseSchema } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";
import {
	type HomeRouteSearch,
	type RouteSearchChange,
	validateHomeSearch,
} from "#/lib/route-search";
import {
	cx,
	segmentAccentActiveClass,
	segmentClass,
	segmentedClass,
} from "#/lib/ui";

export const Route = createFileRoute("/")({
	component: HomeRoute,
	validateSearch: validateHomeSearch,
});

const FEED_TABS = [
	{ value: "for_you", label: "For You" },
	{ value: "following", label: "Following" },
] as const;

function homeSubtitle(meta: QueryEnvelope | null) {
	if (!meta) return "Loading local context...";
	return `${String(meta.stats.home)} items · ${String(meta.stats.needsReply)} waiting · ${meta.transport.statusText}`;
}

async function fetchDataSources() {
	return fetchJson(
		"/api/data-sources",
		undefined,
		liveDataSourcesResponseSchema,
		"Data source status failed",
	);
}

function useBirdAvailable() {
	const dataSourcesQuery = useQuery({
		queryKey: queryKeys.dataSources,
		queryFn: fetchDataSources,
	});
	return (
		dataSourcesQuery.data?.sources.some(
			(source) => source.source === "bird" && source.works,
		) ?? false
	);
}

function HomeRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<HomeRouteView
			searchState={search}
			onSearchChange={(next, options) =>
				void navigate({ search: next, replace: options?.replace })
			}
		/>
	);
}

export function HomeRouteView({
	searchState: controlledSearch,
	onSearchChange,
}: {
	searchState?: HomeRouteSearch;
	onSearchChange?: RouteSearchChange<HomeRouteSearch>;
} = {}) {
	const [localSearch, setLocalSearch] = useState(() => validateHomeSearch({}));
	const searchState = controlledSearch ?? localSearch;
	const updateSearch: RouteSearchChange<HomeRouteSearch> = (next, options) =>
		onSearchChange ? onSearchChange(next, options) : setLocalSearch(next);
	const birdAvailable = useBirdAvailable();
	// For You requires bird; fall back to Following when bird isn't available,
	// regardless of what the URL/local state currently says.
	const effectiveFeed =
		searchState.feed === "for_you" && !birdAvailable
			? "following"
			: searchState.feed;

	return (
		<div className="flex min-h-screen flex-col">
			{birdAvailable ? (
				<div className="flex flex-wrap items-center gap-2 px-4 pt-3">
					<div className={segmentedClass} aria-label="Home feed">
						{FEED_TABS.map((tab) => (
							<button
								key={tab.value}
								type="button"
								aria-pressed={effectiveFeed === tab.value}
								className={cx(
									segmentClass,
									effectiveFeed === tab.value && segmentAccentActiveClass,
								)}
								onClick={() =>
									updateSearch({ ...searchState, feed: tab.value })
								}
							>
								{tab.label}
							</button>
						))}
					</div>
				</div>
			) : null}
			<TimelineRouteFrame
				key={effectiveFeed}
				autoSyncScope={effectiveFeed}
				emptyDetail="Try a different filter or sync the timeline again."
				emptyLabel="No posts in this view"
				errorFallback="Timeline unavailable"
				errorTitle="Could not load posts"
				feed={effectiveFeed}
				initialReplyFilter="all"
				loadingDetail="Reading the local timeline store"
				loadingLabel="Loading posts"
				resource="home"
				searchPlaceholder="Search local timeline"
				subtitle={homeSubtitle}
				syncKind="timeline"
				syncLabel={
					effectiveFeed === "for_you" ? "Sync For You" : "Sync Following"
				}
				title="Home"
			/>
		</div>
	);
}
