import {
  LOG_STANDALONE_ERROR_SQL,
  logStandaloneErrorSql
} from "./logger-helpers.js";

export const LOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    completed_at TEXT NOT NULL DEFAULT '',
    route TEXT NOT NULL,
    compaction_mode TEXT,
    compaction_detection_source TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    endpoint TEXT NOT NULL DEFAULT '',
    request_type TEXT NOT NULL DEFAULT 'http',
    reasoning_effort TEXT,
    request_summary TEXT,
    incoming_request_body TEXT,
    upstream_request_body TEXT,
    upstream_response_body TEXT,
    client_response_body TEXT,
    body_status TEXT NOT NULL DEFAULT 'none',
    compact_response_normalized INTEGER NOT NULL DEFAULT 0,
    compact_response_normalize_reason TEXT,
    compact_response_synthetic_source TEXT,
    source_model TEXT,
    target_model TEXT,
    response_model TEXT,
    response_model_source TEXT NOT NULL DEFAULT 'unavailable',
    status INTEGER NOT NULL,
    upstream_status INTEGER,
    stream_terminal_event TEXT,
    client_disconnect_phase TEXT NOT NULL DEFAULT 'none',
    stream_outcome TEXT,
    stream_oversized_event_count INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL,
    first_token_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    cached_output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    additive_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    additive_cached_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER,
    upstream_host TEXT NOT NULL,
    user_agent TEXT,
    request_id TEXT NOT NULL,
    error_summary TEXT,
    capture_path TEXT,
    capture_status TEXT NOT NULL DEFAULT 'none'
  );
  CREATE INDEX IF NOT EXISTS idx_request_logs_id ON request_logs(id DESC);
  CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id);
`;

const insertedLogStatusSql = `CASE WHEN ${logStandaloneErrorSql("NEW.")} THEN 'error' ELSE 'normal' END`;
const deletedLogStatusSql = `CASE WHEN ${logStandaloneErrorSql("OLD.")} THEN 'error' ELSE 'normal' END`;

export const LOG_FACET_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS request_log_facets (
    upstream_host TEXT NOT NULL,
    route TEXT NOT NULL,
    log_status TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (upstream_host, route, log_status)
  ) WITHOUT ROWID;

  CREATE TRIGGER IF NOT EXISTS trg_request_log_facets_insert
  AFTER INSERT ON request_logs
  BEGIN
    INSERT INTO request_log_facets (upstream_host, route, log_status, count)
    VALUES (NEW.upstream_host, NEW.route, ${insertedLogStatusSql}, 1)
    ON CONFLICT (upstream_host, route, log_status)
    DO UPDATE SET count = count + 1;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_request_log_facets_delete
  AFTER DELETE ON request_logs
  BEGIN
    UPDATE request_log_facets
    SET count = count - 1
    WHERE upstream_host = OLD.upstream_host
      AND route = OLD.route
      AND log_status = ${deletedLogStatusSql};

    DELETE FROM request_log_facets
    WHERE upstream_host = OLD.upstream_host
      AND route = OLD.route
      AND log_status = ${deletedLogStatusSql}
      AND count <= 0;
  END;
`;

export const LOG_FACET_REBUILD_SQL = `
  DELETE FROM request_log_facets;
  INSERT INTO request_log_facets (upstream_host, route, log_status, count)
  SELECT
    upstream_host,
    route,
    CASE WHEN ${LOG_STANDALONE_ERROR_SQL} THEN 'error' ELSE 'normal' END,
    COUNT(*)
  FROM request_logs
  GROUP BY upstream_host, route, CASE WHEN ${LOG_STANDALONE_ERROR_SQL} THEN 'error' ELSE 'normal' END;
`;

export const RECENT_LOG_FIELDS = `
  time,
  completed_at,
  route,
  compaction_mode,
  compaction_detection_source,
  method,
  path,
  endpoint,
  request_type,
  reasoning_effort,
  request_summary,
  NULL AS incoming_request_body,
  NULL AS upstream_request_body,
  NULL AS upstream_response_body,
  NULL AS client_response_body,
  body_status,
  compact_response_normalized,
  compact_response_normalize_reason,
  compact_response_synthetic_source,
  source_model,
  target_model,
  response_model,
  response_model_source,
  status,
  upstream_status,
  stream_terminal_event,
  client_disconnect_phase,
  stream_outcome,
  stream_oversized_event_count,
  duration_ms,
  first_token_ms,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  cached_output_tokens,
  cache_read_input_tokens,
  cache_creation_input_tokens,
  reasoning_tokens,
  additive_cached_input_tokens,
  additive_cached_output_tokens,
  total_tokens,
  upstream_host,
  user_agent,
  request_id,
  error_summary,
  NULL AS capture_path,
  capture_status
`;

export const MIGRATION_COLUMNS: Record<string, string> = {
  completed_at: "TEXT NOT NULL DEFAULT ''",
  compaction_mode: "TEXT",
  compaction_detection_source: "TEXT",
  endpoint: "TEXT NOT NULL DEFAULT ''",
  request_type: "TEXT NOT NULL DEFAULT 'http'",
  reasoning_effort: "TEXT",
  request_summary: "TEXT",
  incoming_request_body: "TEXT",
  upstream_request_body: "TEXT",
  upstream_response_body: "TEXT",
  client_response_body: "TEXT",
  body_status: "TEXT NOT NULL DEFAULT 'none'",
  compact_response_normalized: "INTEGER NOT NULL DEFAULT 0",
  compact_response_normalize_reason: "TEXT",
  compact_response_synthetic_source: "TEXT",
  response_model: "TEXT",
  response_model_source: "TEXT NOT NULL DEFAULT 'unavailable'",
  upstream_status: "INTEGER",
  stream_terminal_event: "TEXT",
  client_disconnect_phase: "TEXT NOT NULL DEFAULT 'none'",
  stream_outcome: "TEXT",
  stream_oversized_event_count: "INTEGER NOT NULL DEFAULT 0",
  error_summary: "TEXT",
  first_token_ms: "INTEGER",
  input_tokens: "INTEGER",
  output_tokens: "INTEGER",
  cached_input_tokens: "INTEGER",
  cached_output_tokens: "INTEGER",
  cache_read_input_tokens: "INTEGER",
  cache_creation_input_tokens: "INTEGER",
  reasoning_tokens: "INTEGER",
  additive_cached_input_tokens: "INTEGER NOT NULL DEFAULT 0",
  additive_cached_output_tokens: "INTEGER NOT NULL DEFAULT 0",
  total_tokens: "INTEGER",
  user_agent: "TEXT",
  capture_path: "TEXT",
  capture_status: "TEXT NOT NULL DEFAULT 'none'"
};
