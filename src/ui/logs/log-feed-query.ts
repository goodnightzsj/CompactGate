import type { LogDrilldownFilter, LogStatusKind, RouteKind } from "../../shared/types.js";
import { ALL_HOSTS_FILTER } from "./log-utils.js";

export interface LogPageQuery {
  route: "all" | RouteKind;
  status: "all" | LogStatusKind;
  host: string;
  search: string;
  drilldown?: LogDrilldownFilter;
  limit: number;
}

/** Filters are retained preferences, not the scope of every Studio page. */
export function logQueryForView(filters: LogPageQuery, filterLogs: boolean): LogPageQuery {
  return filterLogs ? filters : { route: "all", status: "all", host: ALL_HOSTS_FILTER, search: "", limit: filters.limit };
}

export function isUnfilteredQuery(query: LogPageQuery): boolean {
  return query.route === "all" && query.status === "all" &&
    query.host === ALL_HOSTS_FILTER && query.search === "" && !query.drilldown;
}

export function logPageQueryKey(query: LogPageQuery): string {
  return JSON.stringify([query.route, query.status, query.host, query.search, query.limit,
    query.drilldown?.from, query.drilldown?.to,
    query.drilldown?.model === undefined ? [] : [query.drilldown.model]]);
}

export function isCurrentLogRequest(
  requestGeneration: number,
  currentGeneration: number,
  requestId?: number,
  currentRequestId?: number
): boolean {
  return requestGeneration === currentGeneration &&
    (requestId === undefined || requestId === currentRequestId);
}

export function isCurrentLogPageRequest(
  requestGeneration: number,
  currentGeneration: number,
  requestQuery: LogPageQuery,
  currentQuery: LogPageQuery,
  requestId?: number,
  currentRequestId?: number
): boolean {
  return isCurrentLogRequest(
    requestGeneration,
    currentGeneration,
    requestId,
    currentRequestId
  ) && logPageQueryKey(requestQuery) === logPageQueryKey(currentQuery);
}
