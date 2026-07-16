import type { LogStatusKind, RouteKind } from "../../shared/types.js";

export interface LogPageQuery {
  route: "all" | RouteKind;
  status: "all" | LogStatusKind;
  host: string;
  limit: number;
}

export function logPageQueryKey(query: LogPageQuery): string {
  return JSON.stringify([query.route, query.status, query.host, query.limit]);
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
