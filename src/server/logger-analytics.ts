import type { DatabaseSync } from "node:sqlite";
import { DAY_MS } from "../shared/log-range.js";
import type {
  LogStatsMetric,
  LogStatsSnapshot,
  LogStatsSummary,
  LogUsageStatsSnapshot,
  LogAnalyticsSnapshot
} from "../shared/types.js";
import {
  LOG_STANDALONE_ERROR_SQL,
  LOG_EFFECTIVE_MODEL_SQL,
  normalizeRoute,
  readNullableNumber
} from "./logger-helpers.js";

export type LogStatsOptions = LogStatsSnapshot["range"] & {
  view?: "usage";
};

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
    SELECT
      time,
      route,
      upstream_host,
      ${DISPLAY_ENDPOINT} AS endpoint,
      source_model,
      target_model,
      ${LOG_EFFECTIVE_MODEL_SQL} AS response_model,
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

export function readLogStats(db: DatabaseSync, options: LogStatsOptions & { view: "usage" }): LogUsageStatsSnapshot;
export function readLogStats(db: DatabaseSync, options: LogStatsOptions & { view?: undefined }): LogStatsSnapshot;
export function readLogStats(db: DatabaseSync, options: LogStatsOptions): LogAnalyticsSnapshot;
export function readLogStats(db: DatabaseSync, options: LogStatsOptions): LogAnalyticsSnapshot {
  db.exec("SAVEPOINT log_stats");
  try {
    const snapshot = readStatsSnapshot(db, options);
    db.exec("RELEASE log_stats");
    return snapshot;
  } catch (error) {
    db.exec("ROLLBACK TO log_stats; RELEASE log_stats");
    throw error;
  }
}

function readStatsSnapshot(db: DatabaseSync, options: LogStatsOptions): LogAnalyticsSnapshot {
  const params = [options.from, options.to];
  const calendar = options.calendar_tz && calendarGroups(options.from, options.to, options.calendar_tz);
  const generatedAt = new Date().toISOString();
  const retained = db.prepare(
    `SELECT (SELECT MIN(time) FROM request_logs) AS oldest_at,
      (SELECT MAX(time) FROM request_logs) AS newest_at`
  ).get() as Record<string, unknown>;

  // One ephemeral projection per query, not a cache shared across snapshots.
  const rows = db.prepare(`
    WITH analytics_rows AS MATERIALIZED (${ANALYTICS_ROWS_SQL})
    SELECT 'summary' AS dimension, NULL AS key1, NULL AS key2, NULL AS key3, NULL AS key4, ${METRIC_SQL} FROM analytics_rows
    UNION ALL SELECT 'trend', * FROM (
      SELECT substr(time, 1, 13) || ':00:00.000Z' AS key1, NULL, NULL, NULL, ${METRIC_SQL}
      FROM analytics_rows GROUP BY key1 ORDER BY key1
    )
    ${calendar ? `UNION ALL SELECT 'day', * FROM (
      SELECT date(time, ${calendar.offsetSql}) AS key1, NULL, NULL, NULL, ${METRIC_SQL}
      FROM analytics_rows GROUP BY key1
    )` : ""}
    UNION ALL SELECT 'model', * FROM (
      SELECT response_model AS key1, NULL, NULL, NULL, ${METRIC_SQL}
      FROM analytics_rows GROUP BY response_model ORDER BY requests DESC, key1 LIMIT 12
    )
    UNION ALL SELECT 'endpoint', * FROM (
      SELECT endpoint AS key1, NULL, NULL, NULL, ${METRIC_SQL}
      FROM analytics_rows GROUP BY endpoint ORDER BY requests DESC, key1 LIMIT 8
    )
    ${options.view === "usage" ? "" : `
    UNION ALL SELECT 'route', * FROM (
      SELECT route AS key1, NULL, NULL, NULL, ${METRIC_SQL}
      FROM analytics_rows GROUP BY route ORDER BY requests DESC, key1
    )
    UNION ALL SELECT 'host', * FROM (
      SELECT upstream_host AS key1, NULL, NULL, NULL, ${METRIC_SQL}
      FROM analytics_rows GROUP BY upstream_host ORDER BY requests DESC, key1 LIMIT 12
    )
    UNION ALL SELECT 'mapping', * FROM (
      SELECT upstream_host AS key1, source_model AS key2, target_model AS key3, response_model AS key4, ${METRIC_SQL}
      FROM analytics_rows GROUP BY upstream_host, source_model, target_model, response_model
      ORDER BY requests DESC, key1, key2, key3, key4 LIMIT 20
    )`}
  `).all(...params, ...(calendar ? calendar.params : [])) as Array<Record<string, unknown>>;
  const trend = rows.filter(row => row.dimension === "trend");
  const routes = rows.filter(row => row.dimension === "route");
  const hosts = rows.filter(row => row.dimension === "host");
  const models = rows.filter(row => row.dimension === "model");
  const endpoints = rows.filter(row => row.dimension === "endpoint");
  const mappings = rows.filter(row => row.dimension === "mapping");
  const summaryMetric = readMetric(rows.find(row => row.dimension === "summary")!);
  const dailyRows = new Map(rows.filter(row => row.dimension === "day").map(row => [row.key1, row]));

  const common = {
    generated_at: generatedAt,
    range: { from: options.from, to: options.to, ...(options.calendar_tz ? { calendar_tz: options.calendar_tz } : {}) },
    retained_range: {
      oldest_at: readString(retained.oldest_at),
      newest_at: readString(retained.newest_at)
    },
    trend: trend.map((row) => ({
      bucket_start: String(row.key1),
      ...readMetric(row)
    })),
    ...(calendar ? { daily_trend: calendar.dates.map(date => ({ date, ...readMetric(dailyRows.get(date) ?? {}) })) } : {}),
    by_model: models.map((row) => ({
      model: readString(row.key1),
      requests: readNumber(row.requests),
      error_requests: readNumber(row.error_requests),
      usage_observed_requests: readNumber(row.usage_observed_requests),
      input_tokens: readNumber(row.input_tokens),
      cache_read_tokens: readNumber(row.cache_read_tokens),
      total_tokens: readNumber(row.total_tokens)
    })),
    by_endpoint: endpoints.map((row) => ({
      endpoint: readString(row.key1) ?? "未知端点",
      requests: readNumber(row.requests),
      error_requests: readNumber(row.error_requests),
      total_tokens: readNumber(row.total_tokens)
    }))
  };
  if (options.view === "usage") {
    return { ...common, view: "usage", summary: readUsageSummary(db, options, summaryMetric), overview: null };
  }
  return {
    ...common,
    range: options,
    summary: readSummary(db, options, summaryMetric),
    by_route: routes.map((row) => ({
      route: normalizeRoute(row.key1),
      ...readMetric(row)
    })),
    by_host: hosts.map((row) => ({
      host: readString(row.key1) ?? "未知 Host",
      ...readMetric(row)
    })),
    model_mappings: mappings.map((row) => ({
      host: readString(row.key1) ?? "未知 Host",
      source_model: readString(row.key2),
      target_model: readString(row.key3),
      response_model: readString(row.key4),
      ...readMetric(row)
    })),
    overview: options.includeOverview ? readOverview(db, options.to, generatedAt) : null
  };
}

function calendarGroups(from: string, to: string, timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const offsetAt = (time: number) => {
    const name = format.formatToParts(time).find(part => part.type === "timeZoneName")!.value;
    const offset = name.slice(3); // ICU: GMT, GMT±HH:MM or historical GMT±HH:MM:SS.
    if (!offset) return 0;
    const [hours, minutes, seconds = 0] = offset.slice(1).split(":").map(Number);
    return (offset[0] === "-" ? -1 : 1) * (hours * 3600 + minutes * 60 + seconds);
  };
  const start = Date.parse(from);
  const end = Date.parse(to);
  const segments = [{ start, offset: offsetAt(start) }];
  // Find IANA offset changes once per query. SQLite groups the projected rows without an Intl call per log.
  for (let cursor = start; cursor < end - 1;) {
    const sample = Math.min(cursor + DAY_MS, end - 1);
    const offset = offsetAt(sample);
    if (offset !== segments[segments.length - 1].offset) {
      let left = cursor;
      let right = sample;
      while (right - left > 1) {
        const mid = left + Math.floor((right - left) / 2);
        if (offsetAt(mid) === offset) right = mid;
        else left = mid;
      }
      segments.push({ start: right, offset });
    }
    cursor = sample;
  }
  const dates = new Set<string>();
  const params: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const stop = segments[index + 1]?.start ?? end;
    const shift = segment.offset * 1000;
    const firstDate = Math.floor((segment.start + shift) / DAY_MS) * DAY_MS;
    for (let day = firstDate; day < stop + shift; day += DAY_MS) dates.add(new Date(day).toISOString().split("T")[0]);
    if (index + 1 < segments.length) params.push(new Date(stop).toISOString());
    params.push(`${segment.offset} seconds`);
  }
  const offsetSql = segments.length === 1 ? "?" : `CASE ${"WHEN time < ? THEN ? ".repeat(segments.length - 1)}ELSE ? END`;
  return { dates: [...dates].sort(), offsetSql, params };
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

function readSummary(db: DatabaseSync, options: LogStatsOptions, metric?: LogStatsMetric): LogStatsSummary {
  const duration = readPercentiles(db, "duration_ms", options);
  const firstToken = readPercentiles(db, "first_token_ms", options);
  return {
    ...readUsageSummary(db, options, metric),
    duration_p50_ms: duration.p50,
    duration_p95_ms: duration.p95,
    first_token_p50_ms: firstToken.p50,
    first_token_p95_ms: firstToken.p95
  };
}

function readUsageSummary(db: DatabaseSync, options: LogStatsOptions,
  summaryMetric = readSummaryMetric(db, options.from, options.to)
): LogUsageStatsSnapshot["summary"] {
  const rangeMinutes = Math.max(1, (Date.parse(options.to) - Date.parse(options.from)) / 60_000);
  return {
    ...summaryMetric,
    average_rpm: summaryMetric.requests / rangeMinutes,
    average_tpm: summaryMetric.total_tokens / rangeMinutes
  };
}

function readSummaryMetric(db: DatabaseSync, from: string, to: string): LogStatsMetric {
  const row = db.prepare(
    `WITH analytics_rows AS (${ANALYTICS_ROWS_SQL}) SELECT ${METRIC_SQL} FROM analytics_rows`
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
