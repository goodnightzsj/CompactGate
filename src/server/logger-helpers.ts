import { routeProvider } from "../shared/route-meta.js";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource,
  LogStatusKind,
  ProviderLogCounts,
  RequestLogEntry,
  RequestTransport,
  RouteKind
} from "../shared/types.js";

export interface LogPageOptions {
  route?: RouteKind;
  status?: LogStatusKind;
  host?: string;
  limit: number;
  offset: number;
}

export function logStandaloneErrorSql(columnPrefix = ""): string {
  const column = (name: string) => `${columnPrefix}${name}`;
  const tokenDetailsSql = `(
    ${column("input_tokens")} IS NOT NULL OR
    ${column("output_tokens")} IS NOT NULL OR
    ${column("cached_input_tokens")} IS NOT NULL OR
    ${column("cached_output_tokens")} IS NOT NULL OR
    ${column("cache_read_input_tokens")} IS NOT NULL OR
    ${column("cache_creation_input_tokens")} IS NOT NULL OR
    ${column("reasoning_tokens")} IS NOT NULL OR
    ${column("total_tokens")} IS NOT NULL
  )`;

  return `(
    (${column("status")} >= 400 OR ${column("error_summary")} IS NOT NULL) AND
    NOT ${tokenDetailsSql}
  )`;
}

export const LOG_STANDALONE_ERROR_SQL = logStandaloneErrorSql();

export function providerCountsFromRouteCounts(
  counts: Record<"all" | RouteKind, number>
): ProviderLogCounts {
  const providerCounts: ProviderLogCounts = {
    all: counts.all,
    openai: 0,
    claude: 0
  };

  for (const route of ["primary", "compact", "claude"] as const) {
    providerCounts[routeProvider(route)] += counts[route];
  }

  return providerCounts;
}

export function buildWhereClause(options: Pick<LogPageOptions, "route" | "status" | "host">): {
  sql: string;
  params: Array<RouteKind | string>;
} {
  const conditions: string[] = [];
  const params: Array<RouteKind | string> = [];

  if (options.route) {
    conditions.push("route = ?");
    params.push(options.route);
  }

  if (options.status === "normal") {
    conditions.push(`NOT ${LOG_STANDALONE_ERROR_SQL}`);
  } else if (options.status === "error") {
    conditions.push(LOG_STANDALONE_ERROR_SQL);
  }

  if (options.host) {
    conditions.push("upstream_host = ?");
    params.push(options.host);
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params
  };
}

export function buildFacetWhereClause(
  options: Pick<LogPageOptions, "route" | "status" | "host">
): {
  sql: string;
  params: Array<RouteKind | string>;
} {
  const conditions: string[] = [];
  const params: Array<RouteKind | string> = [];

  if (options.route) {
    conditions.push("route = ?");
    params.push(options.route);
  }

  if (options.status) {
    conditions.push("log_status = ?");
    params.push(options.status);
  }

  if (options.host) {
    conditions.push("upstream_host = ?");
    params.push(options.host);
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params
  };
}

export function rowToLogEntry(row: Record<string, unknown>): RequestLogEntry {
  return {
    time: String(row.time),
    completed_at: readCompletedAt(row.completed_at, row.time),
    route: normalizeRoute(row.route),
    method: String(row.method),
    path: String(row.path),
    endpoint: readEndpoint(row.endpoint, String(row.path)),
    request_type: readRequestTransport(row.request_type),
    reasoning_effort: readNullableString(row.reasoning_effort),
    request_summary: readNullableString(row.request_summary),
    incoming_request_body: readNullableString(row.incoming_request_body),
    upstream_request_body: readNullableString(row.upstream_request_body),
    upstream_response_body: readNullableString(row.upstream_response_body),
    client_response_body: readNullableString(row.client_response_body),
    body_status: readBodyStatus(row.body_status),
    compact_response_normalized: readBoolean(row.compact_response_normalized),
    compact_response_normalize_reason: readCompactResponseNormalizeReason(
      row.compact_response_normalize_reason
    ),
    compact_response_synthetic_source: readCompactResponseSyntheticSource(
      row.compact_response_synthetic_source
    ),
    source_model: readNullableString(row.source_model),
    target_model: readNullableString(row.target_model),
    response_model: readNullableString(row.response_model),
    status: readRequiredNumber(row.status),
    duration_ms: readRequiredNumber(row.duration_ms),
    first_token_ms: readNullableNumber(row.first_token_ms),
    input_tokens: readNullableNumber(row.input_tokens),
    output_tokens: readNullableNumber(row.output_tokens),
    cached_input_tokens: readNullableNumber(row.cached_input_tokens),
    cached_output_tokens: readNullableNumber(row.cached_output_tokens),
    cache_read_input_tokens: readNullableNumber(row.cache_read_input_tokens),
    cache_creation_input_tokens: readNullableNumber(row.cache_creation_input_tokens),
    reasoning_tokens: readNullableNumber(row.reasoning_tokens),
    additive_cached_input_tokens: readBoolean(row.additive_cached_input_tokens),
    additive_cached_output_tokens: readBoolean(row.additive_cached_output_tokens),
    total_tokens: readNullableNumber(row.total_tokens),
    upstream_host: String(row.upstream_host),
    user_agent: readNullableString(row.user_agent),
    request_id: String(row.request_id),
    error_summary: readNullableString(row.error_summary),
    capture_path: readNullableString(row.capture_path),
    capture_status: readCaptureStatus(row.capture_status)
  };
}

export function stripLogEntryBodies(entry: RequestLogEntry): RequestLogEntry {
  return {
    ...entry,
    incoming_request_body: null,
    upstream_request_body: null,
    upstream_response_body: null,
    client_response_body: null
  };
}

export function normalizeLogStatus(value: unknown): LogStatusKind {
  return value === "error" ? "error" : "normal";
}

export function normalizeRoute(value: unknown): RouteKind {
  if (value === "compact" || value === "claude") {
    return value;
  }

  return "primary";
}

export function readCount(row: unknown): number {
  return isRecord(row) ? readNullableNumber(row.count) ?? 0 : 0;
}

export function readCaptureStatus(value: unknown): RequestLogEntry["capture_status"] {
  return value === "pending" || value === "present" || value === "purged" || value === "none"
    ? value
    : "none";
}

export function readBodyStatus(value: unknown): RequestLogEntry["body_status"] {
  return value === "present" || value === "purged" ? value : "none";
}

export function readNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value === "string") {
    const text = value.trim();
    const number = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    return Number.isSafeInteger(number) ? number : null;
  }

  return null;
}

function readRequiredNumber(value: unknown): number {
  return readNullableNumber(value) ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function readCompletedAt(value: unknown, fallback: unknown): string {
  const completedAt = readNullableString(value);
  return completedAt ?? String(fallback);
}

function readRequestTransport(value: unknown): RequestTransport {
  return value === "stream" ? "stream" : "http";
}

function readCompactResponseNormalizeReason(
  value: unknown
): CompactResponseNormalizeReason | null {
  return value === "malformed_json" ||
    value === "missing_response_compaction_object" ||
    value === "missing_compaction_output"
    ? value
    : null;
}

function readCompactResponseSyntheticSource(
  value: unknown
): CompactResponseSyntheticSource | null {
  return value === "upstream_response" || value === "request_input" ? value : null;
}

function readEndpoint(value: unknown, pathValue: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  const pathname = pathValue.split("?")[0] ?? "/";
  if (pathname === "/v1") {
    return "/";
  }

  if (pathname.startsWith("/v1/")) {
    return pathname.slice(3);
  }

  return pathname || "/";
}
