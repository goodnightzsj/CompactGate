import type { DatabaseSync } from "node:sqlite";
import type { HostLogCount, RequestLogEntry, RequestLogPage, RouteKind, StatusLogCounts } from "../shared/types.js";
import {
  buildFacetWhereClause, buildWhereClause, type LogPageOptions, LOG_STANDALONE_ERROR_SQL,
  normalizeLogStatus, normalizeRoute, providerCountsFromRouteCounts, readCount,
  readNullableNumber, rowToLogEntry
} from "./logger-helpers.js";
import { RECENT_LOG_FIELDS } from "./logger-schema.js";

export function readLogPage(db: DatabaseSync, options: LogPageOptions): RequestLogPage {
  db.exec("SAVEPOINT log_page");
  try {
    const page = readPageSnapshot(db, options);
    db.exec("RELEASE log_page");
    return page;
  } catch (error) {
    db.exec("ROLLBACK TO log_page; RELEASE log_page");
    throw error;
  }
}

function readPageSnapshot(db: DatabaseSync, options: LogPageOptions): RequestLogPage {
  const limit = Math.max(1, Math.floor(options.limit));
  const offset = Number.isSafeInteger(options.offset)
    ? Math.max(0, Math.floor(options.offset))
    : 0;
  const logs = readLogRows(db, options, limit, offset);
  const filtered = options.search?.trim() || options.drilldown ? readFilteredFacets(db, options) : null;
  const total = filtered ? filtered.total : readFacetTotal(db, options);
  const allTotal = readFacetTotal(db, {});
  const counts = filtered ? filtered.counts : routeCounts(db, options);
  const statusCounts = filtered ? filtered.status_counts : readStatusCounts(db, options);

  return {
    logs,
    latest_sequence: Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS sequence FROM request_logs").get()!.sequence),
    limit,
    offset,
    total,
    all_total: allTotal,
    has_more: offset + logs.length < total,
    counts,
    provider_counts: providerCountsFromRouteCounts(counts),
    status_counts: statusCounts,
    host_counts: filtered ? filtered.host_counts : hostCounts(db, options)
  };
}

function readFilteredFacets(db: DatabaseSync, options: LogPageOptions): Pick<RequestLogPage, "total" | "counts" | "status_counts" | "host_counts"> {
  const matching = buildWhereClause({ search: options.search, drilldown: options.drilldown });
  const total = buildFacetWhereClause(options);
  const routes = buildFacetWhereClause({ status: options.status, host: options.host });
  const statuses = buildFacetWhereClause({ route: options.route, host: options.host });
  const hosts = buildFacetWhereClause({ route: options.route, status: options.status });
  // Materialize search/drilldown once; each facet still excludes its own filter.
  const rows = db.prepare(`
    WITH matching AS MATERIALIZED (
      SELECT route, upstream_host, CASE WHEN ${LOG_STANDALONE_ERROR_SQL} THEN 'error' ELSE 'normal' END AS log_status
      FROM request_logs ${matching.sql}
    )
    SELECT 'total' AS dimension, '' AS value, COUNT(*) AS count, 0 AS primary_count, 0 AS compact_count, 0 AS claude_count
      FROM matching ${total.sql}
    UNION ALL SELECT 'route', route, COUNT(*), 0, 0, 0 FROM matching ${routes.sql} GROUP BY route
    UNION ALL SELECT 'status', log_status, COUNT(*), 0, 0, 0 FROM matching ${statuses.sql} GROUP BY log_status
    UNION ALL SELECT 'host', upstream_host, COUNT(*),
      SUM(CASE WHEN route = 'primary' THEN 1 ELSE 0 END),
      SUM(CASE WHEN route = 'compact' THEN 1 ELSE 0 END),
      SUM(CASE WHEN route = 'claude' THEN 1 ELSE 0 END)
      FROM matching ${hosts.sql} GROUP BY upstream_host
    ORDER BY dimension, count DESC, value ASC
  `).all(...matching.params, ...total.params, ...routes.params, ...statuses.params, ...hosts.params) as Array<Record<string, unknown>>;
  const result = { total: 0, counts: { all: 0, primary: 0, compact: 0, claude: 0 },
    status_counts: { all: 0, normal: 0, error: 0 }, host_counts: [] as HostLogCount[] };
  for (const row of rows) {
    const count = readCount(row);
    if (row.dimension === "total") result.total = count;
    else if (row.dimension === "route") {
      result.counts[normalizeRoute(row.value)] += count;
      result.counts.all += count;
    } else if (row.dimension === "status") {
      result.status_counts[normalizeLogStatus(row.value)] += count;
      result.status_counts.all += count;
    } else if (row.dimension === "host") {
      result.host_counts.push({ host: String(row.value), total: count,
        primary: readNullableNumber(row.primary_count) ?? 0, compact: readNullableNumber(row.compact_count) ?? 0,
        claude: readNullableNumber(row.claude_count) ?? 0 });
    }
  }
  return result;
}

export function readLogRows(db: DatabaseSync,
  options: Omit<LogPageOptions, "limit" | "offset">,
  limit: number,
  offset: number
): RequestLogEntry[] {
  const where = buildWhereClause(options);
  return (
    db
      .prepare(
        `
          SELECT ${RECENT_LOG_FIELDS}
          FROM request_logs
          ${where.sql}
          ORDER BY id DESC
          LIMIT ? OFFSET ?
        `
      )
      .all(...where.params, limit, offset) as Array<Record<string, unknown>>
  ).map(rowToLogEntry);
}

function routeCounts(db: DatabaseSync, options: Omit<LogPageOptions, "limit" | "offset" | "route">): Record<"all" | RouteKind, number> {
  // Callers pass the whole LogPageOptions, so the counted dimension has to be
  // dropped explicitly rather than relied on being absent from the Pick type.
  const facet = { status: options.status, host: options.host };
  const where = buildFacetWhereClause(facet);
  const rows = db
    .prepare(
      `
        SELECT route, SUM(count) AS count
        FROM request_log_facets
        ${where.sql}
        GROUP BY route
      `
    )
    .all(...where.params) as Array<Record<string, unknown>>;
  const counts = {
    all: 0,
    primary: 0,
    compact: 0,
    claude: 0
  };

  for (const row of rows) {
    // Accumulated, not assigned: `normalizeRoute` folds an unrecognised route
    // into `primary`, so two facet rows can land in the same bucket and the
    // second used to overwrite the first, leaving `all` disagreeing with the
    // sum of its parts.
    const route = normalizeRoute(row.route);
    const count = readCount(row);
    counts[route] += count;
    counts.all += count;
  }

  return counts;
}

function readStatusCounts(db: DatabaseSync, options: Omit<LogPageOptions, "limit" | "offset" | "status">): StatusLogCounts {
  const facet = { route: options.route, host: options.host };
  const where = buildFacetWhereClause(facet);
  const rows = db
    .prepare(
      `
        SELECT log_status AS status_kind, SUM(count) AS count
        FROM request_log_facets
        ${where.sql}
        GROUP BY status_kind
      `
    )
    .all(...where.params) as Array<Record<string, unknown>>;
  const counts: StatusLogCounts = {
    all: 0,
    normal: 0,
    error: 0
  };

  for (const row of rows) {
    // Accumulated for the same reason as the route buckets above.
    const status = normalizeLogStatus(row.status_kind);
    const count = readCount(row);
    counts[status] += count;
    counts.all += count;
  }

  return counts;
}

function hostCounts(db: DatabaseSync, options: Omit<LogPageOptions, "limit" | "offset" | "host">): HostLogCount[] {
  const facet = { route: options.route, status: options.status };
  const where = buildFacetWhereClause(facet);
  const rows = db
    .prepare(
      `
        SELECT
          upstream_host AS host,
          SUM(count) AS total,
          SUM(CASE WHEN route = 'primary' THEN count ELSE 0 END) AS primary_count,
          SUM(CASE WHEN route = 'compact' THEN count ELSE 0 END) AS compact_count,
          SUM(CASE WHEN route = 'claude' THEN count ELSE 0 END) AS claude_count
        FROM request_log_facets
        ${where.sql}
        GROUP BY upstream_host
        ORDER BY total DESC, upstream_host ASC
      `
    )
    .all(...where.params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    host: String(row.host),
    total: readNullableNumber(row.total) ?? 0,
    primary: readNullableNumber(row.primary_count) ?? 0,
    compact: readNullableNumber(row.compact_count) ?? 0,
    claude: readNullableNumber(row.claude_count) ?? 0
  }));
}

export function readFacetTotal(db: DatabaseSync, options: Omit<LogPageOptions, "limit" | "offset">): number {
  const raw = Boolean(options.search || options.drilldown);
  const where = raw
    ? buildWhereClause(options)
    : buildFacetWhereClause(options);
  return readCount(
    db
      .prepare(
        `SELECT ${raw ? "COUNT(*)" : "COALESCE(SUM(count), 0)"} AS count FROM ${raw ? "request_logs" : "request_log_facets"} ${where.sql}`
      )
      .get(...where.params)
  );
}
