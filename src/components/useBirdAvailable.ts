import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "#/lib/api-client";
import { liveDataSourcesResponseSchema } from "#/lib/api-contracts";
import { queryKeys } from "#/lib/query-client";

async function fetchDataSources() {
	return fetchJson(
		"/api/data-sources",
		undefined,
		liveDataSourcesResponseSchema,
		"Data source status failed",
	);
}

export function useBirdAvailable() {
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
