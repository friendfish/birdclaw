import { createFileRoute } from "@tanstack/react-router";
import {
	Globe2,
	MapPin,
	RefreshCw,
	Search,
	Users,
	WifiOff,
} from "lucide-react";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type * as GeoJSON from "geojson";
import Supercluster from "supercluster";
import type { MapRef } from "react-map-gl/mapbox";
import { useSelectedAccountId } from "#/components/account-selection";
import { fetchQueryEnvelope } from "#/lib/api-client";
import type { NetworkMapKind, NetworkMapResponse } from "#/lib/network-map";
import type { QueryEnvelope } from "#/lib/types";
import {
	cx,
	errorCopyClass,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	secondaryButtonClass,
	segmentedClass,
	segmentActiveClass,
	segmentClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	statusCopyClass,
} from "#/lib/ui";

export const Route = createFileRoute("/network-map")({
	component: NetworkMapRoute,
});

type ReactMapboxModule = typeof import("react-map-gl/mapbox");
type MapFeature = NetworkMapResponse["features"][number];
type MapBounds = [number, number, number, number];

interface ClusterPointProperties {
	featureIndex: number;
	handle: string;
	name: string;
	avatarUrl: string | null;
	relationship: MapFeature["properties"]["relationship"];
	followersCount: number;
}

interface ClusterAggregateProperties {
	followers: number;
	following: number;
	mutual: number;
}

interface ClusterFeatureProperties extends ClusterAggregateProperties {
	cluster: true;
	cluster_id: number;
	point_count: number;
	point_count_abbreviated: string | number;
}

type ClusterPointFeature = GeoJSON.Feature<
	GeoJSON.Point,
	ClusterPointProperties
>;
type ClusterFeature = GeoJSON.Feature<GeoJSON.Point, ClusterFeatureProperties>;
type ClusterResult = ClusterPointFeature | ClusterFeature;
type MapViewport = { bounds: MapBounds; zoom: number };
type MapTarget = {
	getBounds: () => {
		getWest: () => number;
		getSouth: () => number;
		getEast: () => number;
		getNorth: () => number;
	};
	getZoom: () => number;
};

type SelectedOverlay =
	| { kind: "profile"; feature: MapFeature }
	| {
			kind: "cluster";
			coordinates: [number, number];
			count: number;
			features: MapFeature[];
			stats: ClusterAggregateProperties;
	  };

const CLUSTER_LEAF_SAMPLE_SIZE = 48;

const MAP_TYPES: Array<{ value: NetworkMapKind; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "followers", label: "Followers" },
	{ value: "following", label: "Following" },
	{ value: "mutual", label: "Mutual" },
];

const WORLD_BOUNDS: MapBounds = [-180, -85, 180, 85];
const WORLD_VIEWPORT: MapViewport = { bounds: WORLD_BOUNDS, zoom: 1.15 };

async function fetchMap(
	type: NetworkMapKind,
	refresh: boolean,
	accountId?: string,
	signal?: AbortSignal,
) {
	const url = new URL("/api/network-map", window.location.origin);
	url.searchParams.set("type", type);
	url.searchParams.set("limit", "50000");
	url.searchParams.set("geocodeLimit", refresh ? "80" : "12");
	if (accountId) url.searchParams.set("account", accountId);
	if (refresh) url.searchParams.set("refresh", "true");
	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`Map request failed (${String(response.status)})`);
	}
	return (await response.json()) as NetworkMapResponse;
}

function formatNumber(value: number) {
	return new Intl.NumberFormat().format(value);
}

function formatRelationship(value: MapFeature["properties"]["relationship"]) {
	if (value === "mutual") return "mutual";
	if (value === "following") return "following";
	return "follower";
}

function StatTile({
	icon: Icon,
	label,
	value,
}: {
	icon: typeof Users;
	label: string;
	value: number;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-2 border-b border-[var(--line)] px-4 py-3 sm:border-r">
			<div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink-soft)]">
				<Icon className="size-4" strokeWidth={1.8} />
				<span>{label}</span>
			</div>
			<div className="truncate text-[24px] font-bold tracking-tight text-[var(--ink)]">
				{formatNumber(value)}
			</div>
		</div>
	);
}

function useMapboxModule() {
	const [module, setModule] = useState<ReactMapboxModule | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		import("react-map-gl/mapbox")
			.then((loaded) => {
				if (!cancelled) setModule(loaded);
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setError(cause instanceof Error ? cause.message : "Map failed");
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { module, error };
}

function relationshipColor(
	relationship: MapFeature["properties"]["relationship"],
) {
	if (relationship === "mutual") return "#22c55e";
	if (relationship === "following") return "#f59e0b";
	return "#1d9bf0";
}

function avatarInitial(feature: MapFeature) {
	return (feature.properties.name || feature.properties.handle || "?")
		.slice(0, 1)
		.toUpperCase();
}

function avatarPath(feature: MapFeature) {
	if (!feature.properties.avatarUrl) return null;
	const query = new URLSearchParams({
		profileId: feature.properties.profileId,
		v: feature.properties.avatarUrl,
	});
	return `/api/avatar?${query.toString()}`;
}

function Avatar({
	feature,
	size = 36,
	className,
	style,
}: {
	feature: MapFeature;
	size?: number;
	className?: string;
	style?: CSSProperties;
}) {
	const src = avatarPath(feature);
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const showImage = src && failedSrc !== src;
	return (
		<div
			className={cx(
				"relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--accent-soft)] text-[12px] font-bold text-[var(--accent)] ring-2 ring-white",
				className,
			)}
			style={{ width: size, height: size, ...style }}
		>
			{showImage ? (
				<img
					src={src}
					alt=""
					className="h-full w-full object-cover"
					loading="lazy"
					onError={() => setFailedSrc(src)}
				/>
			) : (
				<span>{avatarInitial(feature)}</span>
			)}
		</div>
	);
}

function clusterGradient(stats: ClusterAggregateProperties) {
	const total = Math.max(1, stats.followers + stats.following + stats.mutual);
	const mutual = (stats.mutual / total) * 100;
	const following = mutual + (stats.following / total) * 100;
	return `conic-gradient(#22c55e 0 ${mutual}%, #f59e0b ${mutual}% ${following}%, #1d9bf0 ${following}% 100%)`;
}

function buildClusterIndex(features: MapFeature[]) {
	const points: ClusterPointFeature[] = features.map(
		(feature, featureIndex) => ({
			type: "Feature",
			geometry: feature.geometry,
			properties: {
				featureIndex,
				handle: feature.properties.handle,
				name: feature.properties.name,
				avatarUrl: feature.properties.avatarUrl,
				relationship: feature.properties.relationship,
				followersCount: feature.properties.followersCount,
			},
		}),
	);
	return new Supercluster<ClusterPointProperties, ClusterAggregateProperties>({
		maxZoom: 18,
		minPoints: 2,
		radius: 64,
		map: (props) => ({
			followers: props.relationship === "followers" ? 1 : 0,
			following: props.relationship === "following" ? 1 : 0,
			mutual: props.relationship === "mutual" ? 1 : 0,
		}),
		reduce: (accumulated, props) => {
			accumulated.followers += props.followers;
			accumulated.following += props.following;
			accumulated.mutual += props.mutual;
		},
	}).load(points);
}

function isCluster(item: ClusterResult): item is ClusterFeature {
	return "cluster" in item.properties && item.properties.cluster === true;
}

function compareClusterFeatures(a: MapFeature, b: MapFeature) {
	return (
		b.properties.followersCount - a.properties.followersCount ||
		a.properties.handle.localeCompare(b.properties.handle)
	);
}

function getClusterDisplayAnchor(
	features: MapFeature[],
	fallback: [number, number],
): [number, number] {
	const buckets = new Map<
		string,
		{ coordinates: [number, number]; count: number; followers: number }
	>();
	for (const feature of features) {
		const [lng, lat] = feature.geometry.coordinates;
		const key = `${lng.toFixed(4)},${lat.toFixed(4)}`;
		const existing = buckets.get(key);
		if (existing) {
			existing.count += 1;
			existing.followers += feature.properties.followersCount;
		} else {
			buckets.set(key, {
				coordinates: [lng, lat],
				count: 1,
				followers: feature.properties.followersCount,
			});
		}
	}
	const best = [...buckets.values()].sort(
		(a, b) => b.count - a.count || b.followers - a.followers,
	)[0];
	return best?.coordinates ?? fallback;
}

function readViewport(target: unknown): MapViewport | null {
	if (!target || typeof target !== "object") return null;
	const map = target as Partial<MapTarget>;
	if (
		typeof map.getBounds !== "function" ||
		typeof map.getZoom !== "function"
	) {
		return null;
	}
	const bounds = map.getBounds();
	return {
		bounds: [
			bounds.getWest(),
			bounds.getSouth(),
			bounds.getEast(),
			bounds.getNorth(),
		],
		zoom: map.getZoom(),
	};
}

function boundsContainFeature(bounds: MapBounds, feature: MapFeature) {
	const [west, south, east, north] = bounds;
	const [lng, lat] = feature.geometry.coordinates;
	const normalizedWest = ((west + 540) % 360) - 180;
	const normalizedEast = ((east + 540) % 360) - 180;
	const inLatitude = lat >= Math.max(-85, south) && lat <= Math.min(85, north);
	const inLongitude =
		east - west >= 360
			? true
			: normalizedWest <= normalizedEast
				? lng >= normalizedWest && lng <= normalizedEast
				: lng >= normalizedWest || lng <= normalizedEast;
	return inLatitude && inLongitude;
}

function featureMatchesSearch(feature: MapFeature, search: string) {
	const needle = search.trim().toLowerCase();
	if (!needle) return true;
	return [
		feature.properties.name,
		feature.properties.handle,
		feature.properties.location,
		feature.properties.resolvedLocation ?? "",
		formatRelationship(feature.properties.relationship),
	]
		.join(" ")
		.toLowerCase()
		.includes(needle);
}

function ProfileMarker({ feature }: { feature: MapFeature }) {
	const color = relationshipColor(feature.properties.relationship);
	return (
		<button
			type="button"
			className="group relative grid size-11 place-items-center rounded-full border-0 bg-transparent p-0 transition-transform hover:z-10 hover:scale-110"
			aria-label={`Open @${feature.properties.handle}`}
			title={`@${feature.properties.handle}`}
		>
			<span
				className="absolute inset-0 rounded-full opacity-90 shadow-[0_10px_28px_rgba(15,20,25,0.28)]"
				style={{ backgroundColor: color }}
			/>
			<Avatar feature={feature} size={34} className="relative ring-[3px]" />
		</button>
	);
}

function ClusterMarker({
	count,
	features,
	stats,
}: {
	count: number;
	features: MapFeature[];
	stats: ClusterAggregateProperties;
}) {
	const size = Math.min(82, Math.max(52, 44 + Math.log2(count) * 7));
	const avatarSize = size >= 72 ? 30 : 25;
	return (
		<button
			type="button"
			className="group relative rounded-full border-0 bg-transparent p-0 transition-transform hover:z-10 hover:scale-105"
			aria-label={`${formatNumber(count)} located profiles`}
			title={`${formatNumber(count)} profiles`}
			style={{ width: size, height: size }}
		>
			<span
				className="absolute inset-0 rounded-full opacity-95 shadow-[0_18px_42px_rgba(15,20,25,0.32)]"
				style={{ background: clusterGradient(stats) }}
			/>
			<span className="absolute inset-[4px] rounded-full bg-white/88 backdrop-blur-sm" />
			<span className="absolute inset-0 flex items-center justify-center">
				{features.slice(0, 4).map((feature, index) => (
					<Avatar
						key={feature.properties.profileId}
						feature={feature}
						size={avatarSize}
						className="absolute"
						style={{
							transform: `translate(${[-10, 10, -7, 8][index] ?? 0}px, ${[-9, -8, 11, 10][index] ?? 0}px)`,
						}}
					/>
				))}
			</span>
			<span className="absolute -right-1 -top-1 min-w-7 rounded-full bg-[#0f1419] px-1.5 py-0.5 text-center text-[11px] font-bold leading-5 text-white ring-2 ring-white">
				{count > 99 ? "99+" : formatNumber(count)}
			</span>
		</button>
	);
}

function MapboxPanel({
	data,
	onViewportChange,
}: {
	data: NetworkMapResponse;
	onViewportChange: (viewport: MapViewport) => void;
}) {
	const { module, error } = useMapboxModule();
	const mapRef = useRef<MapRef | null>(null);
	const [viewport, setViewport] = useState<MapViewport>(WORLD_VIEWPORT);
	const [selected, setSelected] = useState<SelectedOverlay | null>(null);

	const clusterIndex = useMemo(() => buildClusterIndex(data.features), [data]);
	const visibleClusters = useMemo(
		() =>
			clusterIndex.getClusters(
				viewport.bounds,
				Math.max(0, Math.floor(viewport.zoom)),
			) as ClusterResult[],
		[clusterIndex, viewport],
	);

	useEffect(() => {
		setSelected(null);
	}, [data]);

	const updateViewport = useCallback(
		(event: { target: unknown }) => {
			const next = readViewport(event.target);
			if (!next) return;
			setViewport(next);
			onViewportChange(next);
		},
		[onViewportChange],
	);

	if (!data.config.mapboxToken) {
		return <SvgMapFallback data={data} />;
	}
	if (error) {
		return (
			<div className={statusCopyClass}>
				<WifiOff className="mr-2 inline size-4" strokeWidth={1.8} />
				{error}
			</div>
		);
	}
	if (!module) {
		return <div className={statusCopyClass}>Loading map...</div>;
	}

	const { default: Map, Marker, NavigationControl, Popup } = module;
	const style =
		document.documentElement.dataset.theme === "dark"
			? "mapbox://styles/mapbox/dark-v11"
			: "mapbox://styles/mapbox/light-v11";

	return (
		<div className="min-h-[520px] flex-1 overflow-hidden bg-[var(--bg-active)] min-[1180px]:min-h-0">
			<Map
				ref={mapRef}
				initialViewState={{ longitude: 9, latitude: 24, zoom: 1.2 }}
				mapStyle={style}
				mapboxAccessToken={data.config.mapboxToken}
				onClick={() => setSelected(null)}
				onLoad={updateViewport}
				onMoveEnd={updateViewport}
				projection="mercator"
				style={{ width: "100%", height: "100%" }}
			>
				<NavigationControl position="top-right" showCompass={false} />
				{visibleClusters.map((item) => {
					const [longitude, latitude] = item.geometry.coordinates;
					if (isCluster(item)) {
						const fallbackCoordinates = item.geometry.coordinates as [
							number,
							number,
						];
						const leaves = clusterIndex
							.getLeaves(item.properties.cluster_id, CLUSTER_LEAF_SAMPLE_SIZE)
							.map((leaf) => data.features[leaf.properties.featureIndex])
							.filter((feature): feature is MapFeature => Boolean(feature))
							.sort(compareClusterFeatures);
						const [displayLongitude, displayLatitude] = getClusterDisplayAnchor(
							leaves,
							fallbackCoordinates,
						);
						return (
							<Marker
								key={`cluster-${String(item.properties.cluster_id)}`}
								longitude={displayLongitude}
								latitude={displayLatitude}
								anchor="center"
								onClick={(event: { originalEvent?: Event }) => {
									event.originalEvent?.stopPropagation();
									const expansionZoom = Math.min(
										clusterIndex.getClusterExpansionZoom(
											item.properties.cluster_id,
										),
										12,
									);
									mapRef.current?.flyTo?.({
										center: [displayLongitude, displayLatitude],
										zoom: Math.max(viewport.zoom + 0.85, expansionZoom - 0.6),
										duration: 520,
									});
									setSelected({
										kind: "cluster",
										coordinates: [displayLongitude, displayLatitude],
										count: item.properties.point_count,
										features: leaves,
										stats: item.properties,
									});
								}}
							>
								<ClusterMarker
									count={item.properties.point_count}
									features={leaves}
									stats={item.properties}
								/>
							</Marker>
						);
					}
					const feature = data.features[item.properties.featureIndex];
					if (!feature) return null;
					return (
						<Marker
							key={feature.properties.profileId}
							longitude={longitude}
							latitude={latitude}
							anchor="center"
							onClick={(event: { originalEvent?: Event }) => {
								event.originalEvent?.stopPropagation();
								setSelected({ kind: "profile", feature });
							}}
						>
							<ProfileMarker feature={feature} />
						</Marker>
					);
				})}
				{selected ? (
					<Popup
						longitude={
							selected.kind === "profile"
								? selected.feature.geometry.coordinates[0]
								: selected.coordinates[0]
						}
						latitude={
							selected.kind === "profile"
								? selected.feature.geometry.coordinates[1]
								: selected.coordinates[1]
						}
						closeButton={false}
						offset={12}
						onClose={() => setSelected(null)}
					>
						{selected.kind === "profile" ? (
							<ProfilePopup feature={selected.feature} />
						) : (
							<ClusterPopup
								count={selected.count}
								features={selected.features}
								stats={selected.stats}
							/>
						)}
					</Popup>
				) : null}
			</Map>
		</div>
	);
}

function SvgMapFallback({ data }: { data: NetworkMapResponse }) {
	const points = data.features.slice(0, 1500).map((feature) => {
		const [lng, lat] = feature.geometry.coordinates;
		return {
			feature,
			x: ((lng + 180) / 360) * 1000,
			y: ((90 - lat) / 180) * 500,
		};
	});
	return (
		<div className="border-b border-[var(--line)] bg-[var(--bg-active)] px-4 py-4">
			<svg
				viewBox="0 0 1000 500"
				className="h-auto w-full rounded-md border border-[var(--line)] bg-[var(--bg)]"
				role="img"
				aria-label="Network map"
			>
				<defs>
					<pattern
						id="map-grid"
						width="100"
						height="100"
						patternUnits="userSpaceOnUse"
					>
						<path
							d="M 100 0 L 0 0 0 100"
							fill="none"
							stroke="currentColor"
							strokeOpacity="0.08"
							strokeWidth="1"
						/>
					</pattern>
				</defs>
				<rect width="1000" height="500" fill="url(#map-grid)" />
				<path
					d="M60 205 C145 155 210 145 280 178 C352 212 424 186 495 194 C594 206 665 157 746 178 C836 201 907 227 952 282"
					fill="none"
					stroke="currentColor"
					strokeOpacity="0.18"
					strokeWidth="36"
					strokeLinecap="round"
				/>
				{points.map(({ feature, x, y }) => (
					<circle
						key={feature.properties.profileId}
						cx={x}
						cy={y}
						r={feature.properties.relationship === "mutual" ? 4.5 : 3.5}
						fill={
							feature.properties.relationship === "mutual"
								? "#22c55e"
								: feature.properties.relationship === "following"
									? "#f59e0b"
									: "#1d9bf0"
						}
						opacity="0.86"
					/>
				))}
			</svg>
		</div>
	);
}

function ProfilePopup({ feature }: { feature: MapFeature }) {
	return (
		<div className="flex max-w-[280px] gap-3 text-[13px] text-[#0f1419]">
			<Avatar feature={feature} size={48} className="ring-[#d9e2ea]" />
			<div className="min-w-0">
				<div className="truncate font-bold">{feature.properties.name}</div>
				<div className="truncate text-[#536471]">
					@{feature.properties.handle}
				</div>
				<div className="mt-1 line-clamp-2">{feature.properties.location}</div>
				{feature.properties.resolvedLocation ? (
					<div className="truncate text-[#536471]">
						{feature.properties.resolvedLocation}
					</div>
				) : null}
			</div>
		</div>
	);
}

function ClusterPopup({
	count,
	features,
	stats,
}: {
	count: number;
	features: MapFeature[];
	stats: ClusterAggregateProperties;
}) {
	return (
		<div className="w-[290px] text-[13px] text-[#0f1419]">
			<div className="flex items-center justify-between gap-3">
				<div>
					<div className="font-bold">{formatNumber(count)} profiles here</div>
					<div className="text-[#536471]">
						{formatNumber(stats.mutual)} mutual ·{" "}
						{formatNumber(stats.following)} following ·{" "}
						{formatNumber(stats.followers)} followers
					</div>
				</div>
				<div
					className="size-11 shrink-0 rounded-full ring-2 ring-[#d9e2ea]"
					style={{ background: clusterGradient(stats) }}
				/>
			</div>
			<div className="mt-3 flex -space-x-2">
				{features.slice(0, 6).map((feature) => (
					<Avatar
						key={feature.properties.profileId}
						feature={feature}
						size={36}
						className="ring-[#ffffff]"
					/>
				))}
			</div>
			<div className="mt-3 divide-y divide-[#eff3f4]">
				{features.slice(0, 5).map((feature) => (
					<div
						key={feature.properties.profileId}
						className="flex min-w-0 items-center gap-2 py-2"
					>
						<Avatar feature={feature} size={28} className="ring-[#ffffff]" />
						<div className="min-w-0 flex-1">
							<div className="truncate font-semibold">
								{feature.properties.name}
							</div>
							<div className="truncate text-[#536471]">
								@{feature.properties.handle}
							</div>
						</div>
						<div
							className="size-2 rounded-full"
							style={{
								backgroundColor: relationshipColor(
									feature.properties.relationship,
								),
							}}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

function ProfileRow({ feature }: { feature: MapFeature }) {
	return (
		<a
			className="flex min-w-0 gap-3 border-b border-[var(--line)] px-4 py-3 transition-colors hover:bg-[var(--bg-hover)]"
			href={`/profiles/${encodeURIComponent(feature.properties.handle)}`}
		>
			<Avatar feature={feature} size={40} className="ring-[var(--bg)]" />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="truncate font-bold text-[var(--ink)]">
						{feature.properties.name}
					</span>
					<span className="truncate text-[var(--ink-soft)]">
						@{feature.properties.handle}
					</span>
				</div>
				<div className="truncate text-[13px] text-[var(--ink-soft)]">
					{feature.properties.location}
					{feature.properties.resolvedLocation
						? ` -> ${feature.properties.resolvedLocation}`
						: ""}
				</div>
				<div className="mt-1 flex flex-wrap gap-2 text-[12px] text-[var(--ink-soft)]">
					<span>{formatRelationship(feature.properties.relationship)}</span>
					<span>
						{formatNumber(feature.properties.followersCount)} followers
					</span>
				</div>
			</div>
		</a>
	);
}

function VisibleProfilesPanel({
	features,
	search,
	onSearchChange,
	totalVisible,
	zoom,
}: {
	features: MapFeature[];
	search: string;
	onSearchChange: (value: string) => void;
	totalVisible: number;
	zoom: number;
}) {
	return (
		<aside className="flex min-h-[420px] min-w-0 flex-col border-t border-[var(--line)] bg-[var(--bg)] min-[1180px]:h-full min-[1180px]:border-t-0 min-[1180px]:border-l">
			<header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[color:color-mix(in_srgb,var(--bg)_88%,transparent)] px-4 py-3 backdrop-blur">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 className="truncate text-[16px] font-bold text-[var(--ink)]">
							Who's In View
						</h2>
						<p className="truncate text-[13px] text-[var(--ink-soft)]">
							{formatNumber(totalVisible)} in this map view · zoom{" "}
							{zoom.toFixed(1)}
						</p>
					</div>
					<div className="rounded-full border border-[var(--line)] px-2 py-1 text-[12px] font-semibold text-[var(--ink-soft)]">
						{formatNumber(features.length)}
					</div>
				</div>
				<label className={cx(searchFieldShellClass, "mt-3 h-10")}>
					<Search className={searchFieldIconClass} strokeWidth={2} />
					<input
						className={searchFieldInputClass}
						onChange={(event) => onSearchChange(event.target.value)}
						placeholder="Search visible people"
						value={search}
					/>
				</label>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{features.length > 0 ? (
					features.map((feature) => (
						<ProfileRow key={feature.properties.profileId} feature={feature} />
					))
				) : (
					<div className={statusCopyClass}>
						{search.trim()
							? "No visible profiles match that search."
							: "Pan or zoom the map to see profiles in this area."}
					</div>
				)}
			</div>
		</aside>
	);
}

function NetworkMapRoute() {
	const [type, setType] = useState<NetworkMapKind>("all");
	const [meta, setMeta] = useState<QueryEnvelope | null>(null);
	const [metaLoaded, setMetaLoaded] = useState(false);
	const [data, setData] = useState<NetworkMapResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [viewport, setViewport] = useState<MapViewport>(WORLD_VIEWPORT);
	const [visibleSearch, setVisibleSearch] = useState("");
	const selectedAccountId = useSelectedAccountId(meta?.accounts);
	const mapRequestIdRef = useRef(0);
	const mapAbortControllerRef = useRef<AbortController | null>(null);

	const load = useCallback(
		(refresh = false) => {
			const requestId = mapRequestIdRef.current + 1;
			mapRequestIdRef.current = requestId;
			mapAbortControllerRef.current?.abort();
			const controller = new AbortController();
			mapAbortControllerRef.current = controller;
			setLoading(true);
			setError(null);
			fetchMap(type, refresh, selectedAccountId, controller.signal)
				.then((nextData) => {
					if (mapRequestIdRef.current !== requestId) return;
					setData(nextData);
				})
				.catch((cause: unknown) => {
					if (
						controller.signal.aborted ||
						mapRequestIdRef.current !== requestId
					) {
						return;
					}
					setError(cause instanceof Error ? cause.message : "Map unavailable");
				})
				.finally(() => {
					if (mapRequestIdRef.current === requestId) {
						setLoading(false);
					}
				});
		},
		[selectedAccountId, type],
	);

	useEffect(() => {
		const controller = new AbortController();
		fetchQueryEnvelope({ signal: controller.signal })
			.then(setMeta)
			.catch(() => {
				// The map can still load against the default account if status is down.
			})
			.finally(() => {
				if (!controller.signal.aborted) setMetaLoaded(true);
			});
		return () => controller.abort();
	}, []);

	useEffect(() => {
		if (!metaLoaded) return;
		load(false);
	}, [load, metaLoaded]);

	useEffect(
		() => () => {
			mapAbortControllerRef.current?.abort();
		},
		[],
	);

	const visibleFeatures = useMemo(
		() =>
			(data?.features ?? [])
				.slice()
				.filter((feature) => boundsContainFeature(viewport.bounds, feature))
				.sort(
					(a, b) =>
						b.properties.followersCount - a.properties.followersCount ||
						a.properties.handle.localeCompare(b.properties.handle),
				),
		[data, viewport],
	);

	const filteredVisibleFeatures = useMemo(
		() =>
			visibleFeatures
				.filter((feature) => featureMatchesSearch(feature, visibleSearch))
				.slice(0, 160),
		[visibleFeatures, visibleSearch],
	);

	return (
		<section className="flex min-h-screen flex-col min-[1180px]:h-screen min-[1180px]:min-h-0 min-[1180px]:overflow-hidden">
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div>
						<h1 className={pageTitleClass}>Network Map</h1>
						<div className={pageSubtitleClass}>
							{data
								? `${formatNumber(data.meta.locatedProfiles)} located · ${formatNumber(data.meta.meaningfulProfiles)} with usable locations`
								: "Loading network geography..."}
						</div>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							className={secondaryButtonClass}
							type="button"
							onClick={() => load(true)}
							disabled={loading}
						>
							<RefreshCw className={cx("size-4", loading && "animate-spin")} />
							Refresh
						</button>
					</div>
				</div>
				<div className="border-t border-[var(--line)] px-4 py-3">
					<div className={segmentedClass}>
						{MAP_TYPES.map((item) => (
							<button
								key={item.value}
								type="button"
								className={cx(
									segmentClass,
									type === item.value && segmentActiveClass,
								)}
								onClick={() => setType(item.value)}
							>
								{item.label}
							</button>
						))}
					</div>
				</div>
			</header>

			{error ? <div className={errorCopyClass}>{error}</div> : null}
			{data ? (
				<div className="grid min-h-[620px] flex-1 grid-cols-1 min-[1180px]:min-h-0 min-[1180px]:grid-cols-[minmax(0,1fr)_390px] min-[1180px]:overflow-hidden min-[1500px]:grid-cols-[minmax(0,1fr)_430px]">
					<div className="flex min-h-0 min-w-0 flex-col">
						<div className="grid sm:grid-cols-4">
							<StatTile
								icon={Users}
								label="Profiles"
								value={data.meta.totalProfiles}
							/>
							<StatTile
								icon={MapPin}
								label="Locations"
								value={data.meta.meaningfulProfiles}
							/>
							<StatTile
								icon={Globe2}
								label="Located"
								value={data.meta.locatedProfiles}
							/>
							<StatTile
								icon={RefreshCw}
								label="Geocoded"
								value={data.meta.geocodedThisRun}
							/>
						</div>
						{!data.meta.opencageConfigured && data.meta.missingGeocodes > 0 ? (
							<div className={statusCopyClass}>
								OpenCage key missing; showing cached and coordinate locations
								only.
							</div>
						) : null}
						{!data.meta.mapboxTokenConfigured ? (
							<div className={statusCopyClass}>
								Mapbox token missing; showing the lightweight map.
							</div>
						) : null}
						<MapboxPanel data={data} onViewportChange={setViewport} />
					</div>
					<VisibleProfilesPanel
						features={filteredVisibleFeatures}
						onSearchChange={setVisibleSearch}
						search={visibleSearch}
						totalVisible={visibleFeatures.length}
						zoom={viewport.zoom}
					/>
				</div>
			) : loading ? (
				<div className={statusCopyClass}>Loading map...</div>
			) : null}
		</section>
	);
}
