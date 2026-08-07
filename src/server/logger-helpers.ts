import { routeProvider } from "../shared/route-meta.js";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource,
  ClientDisconnectPhase,
  LogStatusKind,
  ProviderLogCounts,
  ProviderStatePortabilityLog,
  RequestLogEntry,
  ResponseModelSource,
  RequestTransport,
  RouteKind,
  StreamOutcome
} from "../shared/types.js";
import { effectiveResponseModel } from "./response-model.js";
import { parseCodexClientUserAgent } from "./codex-version.js";
import { readNumber as readNullableNumber } from "./usage-utils.js";

export { readNullableNumber };

export interface LogPageOptions {
  route?: RouteKind;
  status?: LogStatusKind;
  host?: string;
  search?: string;
  limit: number;
  offset: number;
}

/** Columns searched by the log search box, with SQL-side LIKE fragments. */
export const LOG_SEARCH_COLUMNS = [
  "request_id",
  "source_model",
  "target_model",
  "endpoint",
  "path",
  "upstream_host",
  "request_summary",
  "status"
] as const;

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
    (
      ${column("status")} >= 400 OR
      ${column("error_summary")} IS NOT NULL OR
      (${column("stream_outcome")} IS NOT NULL AND ${column("stream_outcome")} <> 'success')
    ) AND
    NOT (${column("route")} <> 'claude' AND ${tokenDetailsSql})
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

export function buildWhereClause(options: Pick<LogPageOptions, "route" | "status" | "host" | "search">): {
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

  const keyword = options.search?.trim();
  if (keyword) {
    const like = `%${keyword}%`;
    conditions.push(`(${LOG_SEARCH_COLUMNS.map((column) => `${column} LIKE ?`).join(" OR ")})`);
    params.push(...LOG_SEARCH_COLUMNS.map(() => like));
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
  const responseModel = readNullableString(row.response_model);
  const responseModelSource = readResponseModelSource(row.response_model_source);
  const userAgent = readNullableString(row.user_agent);
  return {
    time: String(row.time),
    completed_at: readCompletedAt(row.completed_at, row.time),
    route: normalizeRoute(row.route),
    compaction_mode: readCompactionMode(row.compaction_mode),
    compaction_detection_source: readCompactionDetectionSource(row.compaction_detection_source),
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
    response_model: responseModel,
    response_model_source: responseModelSource,
    effective_response_model: effectiveResponseModel(
      responseModel,
      readNullableString(row.target_model),
      responseModelSource
    ),
    codex_client: parseCodexClientUserAgent(userAgent),
    status: readNullableNumber(row.status) ?? 0,
    upstream_status: readNullableNumber(row.upstream_status),
    stream_terminal_event: readNullableString(row.stream_terminal_event),
    client_disconnect_phase: readClientDisconnectPhase(row.client_disconnect_phase),
    stream_outcome: readStreamOutcome(row.stream_outcome),
    stream_oversized_event_count: readNullableNumber(row.stream_oversized_event_count) ?? 0,
    upstream_response_truncated: readBoolean(row.upstream_response_truncated),
    duration_ms: readNullableNumber(row.duration_ms) ?? 0,
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
    user_agent: userAgent,
    request_id: String(row.request_id),
    error_summary: readNullableString(row.error_summary),
    provider_state_portability: readProviderStatePortability(row.provider_state_portability),
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

function readClientDisconnectPhase(value: unknown): ClientDisconnectPhase {
  return value === "before_headers" || value === "before_terminal" || value === "after_terminal"
    ? value
    : "none";
}

function readStreamOutcome(value: unknown): StreamOutcome | null {
  return value === "success" ||
    value === "upstream_http_error" ||
    value === "upstream_stream_error" ||
    value === "upstream_stream_incomplete" ||
    value === "client_cancel" ||
    value === "client_cancel_after_terminal" ||
    value === "timeout" ||
    value === "upstream_request_error"
    ? value
    : null;
}

function readResponseModelSource(value: unknown): ResponseModelSource {
  return value === "upstream" || value === "target_fallback" ? value : "unavailable";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readProviderStatePortability(value: unknown): ProviderStatePortabilityLog | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      ![
        "not_applicable",
        "disabled",
        "observed",
        "recovery",
        "unknown_source",
        "same_domain",
        "migration"
      ].includes(String(parsed.decision)) ||
      !Array.isArray(parsed.attempts) ||
      !isRecord(parsed.stateful_item_counts)
    ) {
      return null;
    }
    return parsed as unknown as ProviderStatePortabilityLog;
  } catch {
    return null;
  }
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

function readCompactionMode(value: unknown): RequestLogEntry["compaction_mode"] {
  return value === "local" || value === "remote_v1" || value === "remote_v2" ? value : null;
}

function readCompactionDetectionSource(
  value: unknown
): RequestLogEntry["compaction_detection_source"] {
  return value === "path" ||
    value === "input" ||
    value === "body_metadata" ||
    value === "header_metadata"
    ? value
    : null;
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
