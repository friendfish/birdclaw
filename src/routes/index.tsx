import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { TimelineRouteFrame } from "#/components/TimelineRouteFrame";
import { useBirdAvailable } from "#/components/useBirdAvailable";
import type { QueryEnvelope } from "#/lib/api-contracts";
import {
	type HomeRouteSearch,
	type RouteSearchChange,
	validateHomeSearch,
} from "#/lib/route-search";
import {
	cx,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
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
	const { home, homeForYou, homeFollowing, needsReply } = meta.stats;
	// "·" rather than "+": a tweet can be tagged with both feeds, so the two
	// counts can legitimately add up to more than the total.
	return `${String(home)} items (For You ${String(homeForYou)} · Following ${String(homeFollowing)}) · ${String(needsReply)} waiting · ${meta.transport.statusText}`;
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

	const feedTabs = birdAvailable ? (
		<div className={tabStripClass} aria-label="Home feed">
			{FEED_TABS.map((tab) => {
				const active = effectiveFeed === tab.value;
				return (
					<button
						key={tab.value}
						type="button"
						aria-pressed={active}
						className={cx(tabButtonClass, active && tabButtonActiveClass)}
						onClick={() => updateSearch({ ...searchState, feed: tab.value })}
					>
						<span className="relative inline-flex flex-col items-center justify-center py-1">
							{tab.label}
							{active ? <span className={tabButtonIndicatorClass} /> : null}
						</span>
					</button>
				);
			})}
		</div>
	) : null;

	return (
		<TimelineRouteFrame
			key={effectiveFeed}
			autoSyncScope={effectiveFeed}
			emptyDetail="Try a different filter or sync the timeline again."
			emptyLabel="No posts in this view"
			errorFallback="Timeline unavailable"
			errorTitle="Could not load posts"
			feed={effectiveFeed}
			feedTabs={feedTabs}
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
	);
}
