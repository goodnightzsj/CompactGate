import { routeProvider } from "../../shared/route-meta.js";
import type {
  HostLogCount,
  LogStatusKind,
  ProviderLogCounts,
  RequestLogEntry,
  RequestLogPage,
  RouteKind,
  StatusLogCounts
} from "../../shared/types.js";
import { api } from "../shared/api.js";
import { hasTokenDetails } from "./log-token-metrics.js";
export {
  cacheCreationInputTokens,
  cacheReadInputTokens,
  cachedInputTotalTokens,
  displayInputTokens,
  displayTotalTokens,
  formatCacheHitRate,
  hasAdditiveCachedInput,
  hasAdditiveCachedOutput,
  hasTokenDetails,
  totalInputTokens
} from "./log-token-metrics.js";

export type HostFilterOption = HostLogCount;

export const ALL_HOSTS_FILTER = "__all_hosts__";
export const DEFAULT_LOG_PAGE_LIMIT = 200;

export function modelReasoningLabel(entry: RequestLogEntry): string {
  const model = entry.target_model ?? entry.source_model ?? (entry.route === "claude" ? "Claude" : "model");
  const reasoning = entry.reasoning_effort ?? "standard";
  return `${model}\u2009·\u2009${reasoning}`;
}

export function logStatusKind(entry: RequestLogEntry): LogStatusKind {
  const hasStandaloneError = (entry.status >= 400 || Boolean(entry.error_summary)) && !hasTokenDetails(entry);
  return hasStandaloneError ? "error" : "normal";
}

export function logStatusToneClass(entry: RequestLogEntry): "is-ok" | "is-err" {
  return logStatusKind(entry) === "error" ? "is-err" : "is-ok";
}

export function buildHostFilterOptions(
  hostCounts: HostLogCount[],
  selectedHost: string
): HostFilterOption[] {
  const options = hostCounts.map((option) => ({ ...option }));

  if (selectedHost !== ALL_HOSTS_FILTER && !options.some((option) => option.host === selectedHost)) {
    options.push({
      host: selectedHost,
      total: 0,
      primary: 0,
      compact: 0,
      claude: 0
    });
  }

  return options.sort((left, right) => {
    if (right.total !== left.total) {
      return right.total - left.total;
    }

    return left.host.localeCompare(right.host);
  });
}

export function emptyLogPage(limit: number): RequestLogPage {
  return {
    logs: [],
    limit,
    offset: 0,
    total: 0,
    all_total: 0,
    has_more: false,
    counts: {
      all: 0,
      primary: 0,
      compact: 0,
      claude: 0
    },
    provider_counts: {
      all: 0,
      openai: 0,
      claude: 0
    },
    status_counts: {
      all: 0,
      normal: 0,
      error: 0
    },
    host_counts: []
  };
}

export async function fetchLogPage({
  route,
  status,
  host,
  limit,
  offset
}: {
  route: "all" | RouteKind;
  status: "all" | LogStatusKind;
  host: string;
  limit: number;
  offset: number;
}): Promise<RequestLogPage> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset)
  });

  if (route !== "all") {
    params.set("route", route);
  }

  if (status !== "all") {
    params.set("status", status);
  }

  if (host !== ALL_HOSTS_FILTER) {
    params.set("host", host);
  }

  return api<RequestLogPage>(`/api/logs/recent?${params.toString()}`);
}

export function appendLogPage(previous: RequestLogPage, nextPage: RequestLogPage): RequestLogPage {
  return {
    ...nextPage,
    offset: 0,
    logs: mergeUniqueLogs([...previous.logs, ...nextPage.logs])
  };
}

export function mergeSnapshotLogPage(
  previous: RequestLogPage,
  snapshotPage: RequestLogPage
): RequestLogPage {
  const logs = mergeUniqueLogs([...snapshotPage.logs, ...previous.logs]);

  return {
    ...snapshotPage,
    offset: 0,
    logs,
    has_more: logs.length < snapshotPage.total
  };
}

export function mergeLiveLogPage(
  previous: RequestLogPage,
  nextEntry: RequestLogEntry,
  routeFilter: "all" | RouteKind,
  statusFilter: "all" | LogStatusKind,
  hostFilter: string
): RequestLogPage {
  const duplicate = previous.logs.some((entry) => entry.request_id === nextEntry.request_id);
  const matchesFilter = logEntryMatchesFilter(nextEntry, routeFilter, statusFilter, hostFilter);
  const matchesRouteCountScope = logEntryMatchesFilter(nextEntry, "all", statusFilter, hostFilter);
  const matchesStatusCountScope = logEntryMatchesFilter(nextEntry, routeFilter, "all", hostFilter);
  const matchesHostCountScope = logEntryMatchesFilter(nextEntry, routeFilter, statusFilter, ALL_HOSTS_FILTER);
  const nextLogs = matchesFilter
    ? [nextEntry, ...previous.logs.filter((entry) => entry.request_id !== nextEntry.request_id)]
    : previous.logs;
  const nextRouteCounts = incrementRouteCounts(
    previous.counts,
    nextEntry.route,
    duplicate || !matchesRouteCountScope
  );

  return {
    ...previous,
    logs: nextLogs,
    total: previous.total + (matchesFilter && !duplicate ? 1 : 0),
    all_total: previous.all_total + (duplicate ? 0 : 1),
    counts: nextRouteCounts,
    provider_counts: incrementProviderCounts(
      previous.provider_counts,
      nextEntry.route,
      duplicate || !matchesRouteCountScope
    ),
    status_counts: incrementStatusCounts(
      previous.status_counts,
      logStatusKind(nextEntry),
      duplicate || !matchesStatusCountScope
    ),
    host_counts: incrementHostCounts(previous.host_counts, nextEntry, duplicate || !matchesHostCountScope)
  };
}

function mergeUniqueLogs(logs: RequestLogEntry[]): RequestLogEntry[] {
  const seen = new Set<string>();
  const next: RequestLogEntry[] = [];

  for (const entry of logs) {
    if (seen.has(entry.request_id)) {
      continue;
    }

    seen.add(entry.request_id);
    next.push(entry);
  }

  return next;
}

function logEntryMatchesFilter(
  entry: RequestLogEntry,
  routeFilter: "all" | RouteKind,
  statusFilter: "all" | LogStatusKind,
  hostFilter: string
): boolean {
  const routeMatches = routeFilter === "all" || entry.route === routeFilter;
  const statusMatches = statusFilter === "all" || logStatusKind(entry) === statusFilter;
  const hostMatches = hostFilter === ALL_HOSTS_FILTER || entry.upstream_host === hostFilter;
  return routeMatches && statusMatches && hostMatches;
}

function incrementRouteCounts(
  counts: Record<"all" | RouteKind, number>,
  route: RouteKind,
  duplicate: boolean
): Record<"all" | RouteKind, number> {
  if (duplicate) {
    return counts;
  }

  return {
    ...counts,
    all: counts.all + 1,
    [route]: counts[route] + 1
  };
}

function incrementProviderCounts(
  counts: ProviderLogCounts,
  route: RouteKind,
  duplicate: boolean
): ProviderLogCounts {
  if (duplicate) {
    return counts;
  }

  const provider = routeProvider(route);
  return {
    ...counts,
    all: counts.all + 1,
    [provider]: counts[provider] + 1
  };
}

function incrementStatusCounts(
  counts: StatusLogCounts,
  status: LogStatusKind,
  skip: boolean
): StatusLogCounts {
  if (skip) {
    return counts;
  }

  return {
    ...counts,
    all: counts.all + 1,
    [status]: counts[status] + 1
  };
}

function incrementHostCounts(
  hostCounts: HostLogCount[],
  entry: RequestLogEntry,
  duplicate: boolean
): HostLogCount[] {
  if (duplicate) {
    return hostCounts;
  }

  const next = hostCounts.map((option) => ({ ...option }));
  const existing = next.find((option) => option.host === entry.upstream_host);

  if (existing) {
    existing.total += 1;
    existing[entry.route] += 1;
  } else {
    next.push({
      host: entry.upstream_host,
      total: 1,
      primary: entry.route === "primary" ? 1 : 0,
      compact: entry.route === "compact" ? 1 : 0,
      claude: entry.route === "claude" ? 1 : 0
    });
  }

  return next.sort((left, right) => {
    if (right.total !== left.total) {
      return right.total - left.total;
    }

    return left.host.localeCompare(right.host);
  });
}
