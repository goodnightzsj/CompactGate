import type { DatabaseSync } from "node:sqlite";
import type {
  LogStatsMetric,
  LogStatsSnapshot,
  LogStatsSummary
} from "../shared/types.js";
import {
  LOG_STANDALONE_ERROR_SQL,
  normalizeRoute,
  readNullableNumber
} from "./logger-helpers.js";

export interface LogStatsOptions {
  from: string;
  to: string;
  includeOverview?: boolean;
}

const validToken = (column: string) =>
  `(CASE WHEN typeof(${column}) = 'integer' AND ${column} >= 0 THEN ${column} ELSE NULL END)`;

const INPUT = validToken("input_tokens");
const OUTPUT = validToken("output_tokens");
const CACHED_INPUT = validToken("cached_input_tokens");
const CACHED_OUTPUT = validToken("cached_output_tokens");
const CACHE_READ = validToken("cache_read_input_tokens");
const CACHE_CREATION = validToken("cache_creation_input_tokens");
const REASONING = validToken("reasoning_tokens");
const TOTAL = validToken("total_tokens");
const ADDITIVE_INPUT = `(
  additive_cached_input_tokens = 1 OR
  (${CACHED_INPUT} IS NOT NULL AND ${INPUT} IS NOT NULL AND ${CACHED_INPUT} > ${INPUT})
)`;
const CACHED_INPUT_TOTAL = `COALESCE(
  ${CACHED_INPUT},
  CASE WHEN ${CACHE_READ} IS NOT NULL OR ${CACHE_CREATION} IS NOT NULL
    THEN COALESCE(${CACHE_READ}, 0) + COALESCE(${CACHE_CREATION}, 0)
  END
)`;
const CACHE_READ_TOTAL = `CASE
  WHEN ${CACHE_READ} IS NOT NULL THEN ${CACHE_READ}
  WHEN ${CACHED_INPUT} IS NULL THEN NULL
  WHEN NOT ${ADDITIVE_INPUT} THEN ${CACHED_INPUT}
  ELSE MAX(0, ${CACHED_INPUT} - COALESCE(${CACHE_CREATION}, 0))
END`;
const TOTAL_INPUT = `CASE
  WHEN ${INPUT} IS NULL AND ${CACHED_INPUT} IS NULL AND ${CACHE_READ} IS NULL AND ${CACHE_CREATION} IS NULL
    THEN NULL
  WHEN ${ADDITIVE_INPUT}
    THEN COALESCE(${INPUT}, 0) + COALESCE(${CACHE_READ_TOTAL}, 0) + COALESCE(${CACHE_CREATION}, 0)
  ELSE ${INPUT}
END`;
const USAGE_OBSERVED = `(
  ${INPUT} IS NOT NULL OR ${OUTPUT} IS NOT NULL OR ${CACHED_INPUT} IS NOT NULL OR
  ${CACHED_OUTPUT} IS NOT NULL OR ${CACHE_READ} IS NOT NULL OR ${CACHE_CREATION} IS NOT NULL OR
  ${REASONING} IS NOT NULL OR ${TOTAL} IS NOT NULL
)`;
const TOTAL_TOKEN_FLOOR = `(
  COALESCE(${INPUT}, 0) + COALESCE(${OUTPUT}, 0) +
  CASE WHEN ${ADDITIVE_INPUT} THEN COALESCE(${CACHED_INPUT_TOTAL}, 0) ELSE 0 END +
  CASE WHEN additive_cached_output_tokens = 1 THEN COALESCE(${CACHED_OUTPUT}, 0) ELSE 0 END
)`;
const EFFECTIVE_TOTAL = `CASE WHEN ${USAGE_OBSERVED}
  THEN MAX(COALESCE(${TOTAL}, 0), ${TOTAL_TOKEN_FLOOR})
END`;
const DISPLAY_ENDPOINT = `COALESCE(
  NULLIF(CASE WHEN instr(path, '?') > 0 THEN substr(path, 1, instr(path, '?') - 1) ELSE path END, ''),
  NULLIF(endpoint, '')
)`;

const ANALYTICS_ROWS_SQL = `
  WITH analytics_rows AS (
    SELECT
      time,
      route,
      upstream_host,
      ${DISPLAY_ENDPOINT} AS endpoint,
      source_model,
      target_model,
      CASE WHEN response_model_source = 'target_fallback' THEN target_model ELSE response_model END AS response_model,
      CASE WHEN ${LOG_STANDALONE_ERROR_SQL} THEN 1 ELSE 0 END AS is_error,
      CASE WHEN typeof(duration_ms) IN ('integer', 'real') AND duration_ms >= 0 THEN duration_ms END AS duration_ms,
      CASE WHEN typeof(first_token_ms) IN ('integer', 'real') AND first_token_ms >= 0 THEN first_token_ms END AS first_token_ms,
      CASE WHEN ${USAGE_OBSERVED} THEN 1 ELSE 0 END AS usage_observed,
      ${TOTAL_INPUT} AS input_tokens,
      ${OUTPUT} AS output_tokens,
      ${CACHE_READ_TOTAL} AS cache_read_tokens,
      -- Reported for both dialects. Its own SUM is the only place it lands;
      -- TOTAL_INPUT and TOTAL_TOKEN_FLOOR each re-derive the additive decision
      -- from the raw columns, so surfacing it here cannot double count.
      ${CACHE_CREATION} AS cache_creation_tokens,
      ${REASONING} AS reasoning_tokens,
      ${EFFECTIVE_TOTAL} AS total_tokens
    FROM request_logs
    WHERE time >= ? AND time < ?
  )
`;

const METRIC_SQL = `
  COUNT(*) AS requests,
  COALESCE(SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END), 0) AS normal_requests,
  COALESCE(SUM(is_error), 0) AS error_requests,
  COALESCE(SUM(usage_observed), 0) AS usage_observed_requests,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  AVG(duration_ms) AS average_duration_ms,
  AVG(first_token_ms) AS average_first_token_ms
`;

export function readLogStats(db: DatabaseSync, options: LogStatsOptions): LogStatsSnapshot {
  const params = [options.from, options.to];
  const generatedAt = new Date().toISOString();
  const retained = db.prepare(
    "SELECT MIN(time) AS oldest_at, MAX(time) AS newest_at FROM request_logs"
  ).get() as Record<string, unknown>;

  const trend = db.prepare(`
    ${ANALYTICS_ROWS_SQL}
    SELECT substr(time, 1, 13) || ':00:00.000Z' AS bucket_start, ${METRIC_SQL}
    FROM analytics_rows
    GROUP BY bucket_start
    ORDER BY bucket_start
  `).all(...params) as Array<Record<string, unknown>>;

  const routes = db.prepare(`
    ${ANALYTICS_ROWS_SQL}
    SELECT route, ${METRIC_SQL}
    FROM analytics_rows
    GROUP BY route
    ORDER BY requests DESC, route
  `).all(...params) as Array<Record<string, unknown>>;

  const hosts = db.prepare(`
    ${ANALYTICS_ROWS_SQL}
    SELECT upstream_host AS host, ${METRIC_SQL}
    FROM analytics_rows
    GROUP BY upstream_host
    ORDER BY requests DESC, host
    LIMIT 12
  `).all(...params) as Array<Record<string, unknown>>;

  const models = db.prepare(`
    ${ANALYTICS_ROWS_SQL}
    SELECT
      response_model AS model,
      ${METRIC_SQL}
    FROM analytics_rows
    GROUP BY response_model
    ORDER BY requests DESC, model
    LIMIT 12
  `).all(...params) as Array<Record<string, unknown>>;

  const endpoints = db.prepare(`
    ${ANALYTICS_ROWS_SQL}
    SELECT
      endpoint,
      COUNT(*) AS requests,
      COALESCE(SUM(is_error), 0) AS error_requests,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM analytics_rows
    GROUP BY endpoint
    ORDER BY requests DESC, endpoint
    LIMIT 8
  `).all(...params) as Array<Record<string, unknown>>;

  const mappings = db.prepare(`
    ${ANALYTICS_ROWS_SQL}
    SELECT
      upstream_host AS host,
      source_model,
      target_model,
      response_model,
      ${METRIC_SQL}
    FROM analytics_rows
    GROUP BY upstream_host, source_model, target_model, response_model
    ORDER BY requests DESC, host, source_model, target_model, response_model
    LIMIT 20
  `).all(...params) as Array<Record<string, unknown>>;

  return {
    generated_at: generatedAt,
    range: options,
    retained_range: {
      oldest_at: readString(retained.oldest_at),
      newest_at: readString(retained.newest_at)
    },
    summary: readSummary(db, options),
    trend: trend.map((row) => ({
      bucket_start: String(row.bucket_start),
      ...readMetric(row)
    })),
    by_route: routes.map((row) => ({
      route: normalizeRoute(row.route),
      ...readMetric(row)
    })),
    by_host: hosts.map((row) => ({
      host: readString(row.host) ?? "未知 Host",
      ...readMetric(row)
    })),
    by_model: models.map((row) => ({
      model: readString(row.model),
      requests: readNumber(row.requests),
      error_requests: readNumber(row.error_requests),
      usage_observed_requests: readNumber(row.usage_observed_requests),
      input_tokens: readNumber(row.input_tokens),
      cache_read_tokens: readNumber(row.cache_read_tokens),
      total_tokens: readNumber(row.total_tokens)
    })),
    by_endpoint: endpoints.map((row) => ({
      endpoint: readString(row.endpoint) ?? "未知端点",
      requests: readNumber(row.requests),
      error_requests: readNumber(row.error_requests),
      total_tokens: readNumber(row.total_tokens)
    })),
    model_mappings: mappings.map((row) => ({
      host: readString(row.host) ?? "未知 Host",
      source_model: readString(row.source_model),
      target_model: readString(row.target_model),
      response_model: readString(row.response_model),
      ...readMetric(row)
    })),
    overview: options.includeOverview ? readOverview(db, options.to, generatedAt) : null
  };
}

function readOverview(
  db: DatabaseSync,
  to: string,
  generatedAt: string
): NonNullable<LogStatsSnapshot["overview"]> {
  const end = new Date(to);
  const today = new Date(end);
  today.setHours(0, 0, 0, 0);
  const generatedAtMs = Date.parse(generatedAt);
  return {
    recent: {
      one_minute: readSummaryMetric(
        db,
        new Date(generatedAtMs - 60_000).toISOString(),
        generatedAt
      ),
      five_minutes: readSummary(db, {
        from: new Date(generatedAtMs - 5 * 60_000).toISOString(),
        to: generatedAt
      })
    },
    today: {
      from: today.toISOString(),
      to,
      summary: readSummaryMetric(db, today.toISOString(), to)
    },
    retained: {
      summary: readSummaryMetric(
        db,
        "0000-01-01T00:00:00.000Z",
        "9999-12-31T23:59:59.999Z"
      )
    }
  };
}

function readSummary(db: DatabaseSync, options: LogStatsOptions): LogStatsSummary {
  const summaryMetric = readSummaryMetric(db, options.from, options.to);
  const duration = readPercentiles(db, "duration_ms", options);
  const firstToken = readPercentiles(db, "first_token_ms", options);
  const rangeMinutes = Math.max(1, (Date.parse(options.to) - Date.parse(options.from)) / 60_000);
  return {
    ...summaryMetric,
    duration_p50_ms: duration.p50,
    duration_p95_ms: duration.p95,
    first_token_p50_ms: firstToken.p50,
    first_token_p95_ms: firstToken.p95,
    average_rpm: summaryMetric.requests / rangeMinutes,
    average_tpm: summaryMetric.total_tokens / rangeMinutes
  };
}

function readSummaryMetric(db: DatabaseSync, from: string, to: string): LogStatsMetric {
  const row = db.prepare(
    `${ANALYTICS_ROWS_SQL} SELECT ${METRIC_SQL} FROM analytics_rows`
  ).get(from, to) as Record<string, unknown>;
  return readMetric(row);
}

function readMetric(row: Record<string, unknown>): LogStatsMetric {
  return {
    requests: readNumber(row.requests),
    normal_requests: readNumber(row.normal_requests),
    error_requests: readNumber(row.error_requests),
    usage_observed_requests: readNumber(row.usage_observed_requests),
    input_tokens: readNumber(row.input_tokens),
    output_tokens: readNumber(row.output_tokens),
    cache_read_tokens: readNumber(row.cache_read_tokens),
    cache_creation_tokens: readNumber(row.cache_creation_tokens),
    reasoning_tokens: readNumber(row.reasoning_tokens),
    total_tokens: readNumber(row.total_tokens),
    average_duration_ms: readFiniteNumber(row.average_duration_ms),
    average_first_token_ms: readFiniteNumber(row.average_first_token_ms)
  };
}

function readPercentiles(
  db: DatabaseSync,
  column: "duration_ms" | "first_token_ms",
  options: LogStatsOptions
): { p50: number | null; p95: number | null } {
  const row = db.prepare(`
    WITH ranked AS (
      SELECT
        ${column} AS value,
        ROW_NUMBER() OVER (ORDER BY ${column}) AS row_number,
        COUNT(*) OVER () AS row_count
      FROM request_logs
      WHERE time >= ? AND time < ?
        AND typeof(${column}) IN ('integer', 'real')
        AND ${column} >= 0
    )
    SELECT
      MAX(CASE WHEN row_number = CAST(row_count * 0.50 + 0.999999 AS INTEGER) THEN value END) AS p50,
      MAX(CASE WHEN row_number = CAST(row_count * 0.95 + 0.999999 AS INTEGER) THEN value END) AS p95
    FROM ranked
  `).get(options.from, options.to) as Record<string, unknown>;

  return {
    p50: readNullableNumber(row.p50),
    p95: readNullableNumber(row.p95)
  };
}

function readNumber(value: unknown): number {
  return readNullableNumber(value) ?? 0;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
