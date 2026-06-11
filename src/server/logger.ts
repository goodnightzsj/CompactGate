import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  HostLogCount,
  RequestLogEntry,
  RequestLogPage,
  RouteKind,
  StatusLogCounts
} from "../shared/types.js";
import {
  buildWhereClause,
  type LogPageOptions,
  LOG_STANDALONE_ERROR_SQL,
  normalizeLogStatus,
  normalizeRoute,
  providerCountsFromRouteCounts,
  readCount,
  readNullableNumber,
  rowToLogEntry
} from "./logger-helpers.js";
import {
  LOG_TABLE_SQL,
  MIGRATION_COLUMNS,
  RECENT_LOG_FIELDS
} from "./logger-schema.js";

export interface RequestLoggerOptions {
  maxDatabaseBytes?: number;
  maxPersistedEntries?: number;
}

export const DEFAULT_MAX_LOG_DATABASE_BYTES = 20 * 1024 * 1024 * 1024;

const STORAGE_PRUNE_DELETE_FRACTION = 0.1;
const STORAGE_PRUNE_MIN_DELETE_ROWS = 100;
const STORAGE_PRUNE_MAX_PASSES = 20;

export function resolveDefaultLogDatabasePath(configPath: string): string {
  const configBaseName = path.basename(configPath, path.extname(configPath));
  return path.resolve(path.dirname(configPath), `${configBaseName}-logs.sqlite`);
}

export function resolveLogDatabasePath(configPath: string): string {
  return resolveDefaultLogDatabasePath(configPath);
}

export class RequestLogger {
  private readonly db: DatabaseSync;

  private readonly databasePath: string;

  private readonly maxPersistedEntries: number | null;

  private readonly maxDatabaseBytes: number | null;

  private closed = false;

  constructor(
    private keepRecent: number,
    databasePath: string,
    options: RequestLoggerOptions = {}
  ) {
    const resolvedPath = path.resolve(databasePath);
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.databasePath = resolvedPath;
    this.maxPersistedEntries = normalizeMaxPersistedEntries(options.maxPersistedEntries);
    this.maxDatabaseBytes = normalizeMaxDatabaseBytes(options.maxDatabaseBytes);
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(LOG_TABLE_SQL);
    this.migratePersistedSchema();
    this.prunePersistedEntries();
    this.prunePersistedStorage();
  }

  resize(keepRecent: number): void {
    this.keepRecent = keepRecent;
  }

  getDatabasePath(): string {
    return this.databasePath;
  }

  add(entry: RequestLogEntry): void {
    try {
      this.db
        .prepare(
          `
            INSERT INTO request_logs (
              time,
              route,
              method,
              path,
              endpoint,
              request_type,
              reasoning_effort,
              request_summary,
              incoming_request_body,
              upstream_request_body,
              upstream_response_body,
              source_model,
              target_model,
              status,
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
              error_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          entry.time,
          entry.route,
          entry.method,
          entry.path,
          entry.endpoint,
          entry.request_type,
          entry.reasoning_effort,
          entry.request_summary,
          entry.incoming_request_body,
          entry.upstream_request_body,
          entry.upstream_response_body,
          entry.source_model,
          entry.target_model,
          entry.status,
          entry.duration_ms,
          entry.first_token_ms,
          entry.input_tokens,
          entry.output_tokens,
          entry.cached_input_tokens,
          entry.cached_output_tokens,
          entry.cache_read_input_tokens,
          entry.cache_creation_input_tokens,
          entry.reasoning_tokens,
          entry.additive_cached_input_tokens ? 1 : 0,
          entry.additive_cached_output_tokens ? 1 : 0,
          entry.total_tokens,
          entry.upstream_host,
          entry.user_agent,
          entry.request_id,
          entry.error_summary
      );
      this.prunePersistedEntries();
      this.prunePersistedStorage();
    } catch (error) {
      console.error(`Failed to persist request log to ${this.databasePath}.`, error);
    }
  }

  recent(route?: RouteKind): RequestLogEntry[] {
    return this.page({
      route,
      limit: this.keepRecent,
      offset: 0
    }).logs;
  }

  page(options: LogPageOptions): RequestLogPage {
    const limit = Math.max(1, Math.floor(options.limit));
    const offset = Number.isSafeInteger(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
    const where = buildWhereClause(options);
    const logs = (
      this.db
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
    const total = readCount(
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM request_logs ${where.sql}`)
        .get(...where.params)
    );
    const allTotal = readCount(
      this.db.prepare("SELECT COUNT(*) AS count FROM request_logs").get()
    );
    const counts = this.routeCounts(options);
    const statusCounts = this.statusCounts(options);

    return {
      logs,
      limit,
      offset,
      total,
      all_total: allTotal,
      has_more: offset + logs.length < total,
      counts,
      provider_counts: providerCountsFromRouteCounts(counts),
      status_counts: statusCounts,
      host_counts: this.hostCounts(options)
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.db.close();
  }

  private migratePersistedSchema(): void {
    const existingColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(request_logs)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    for (const [name, definition] of Object.entries(MIGRATION_COLUMNS)) {
      if (!existingColumns.has(name)) {
        this.db.exec(`ALTER TABLE request_logs ADD COLUMN ${name} ${definition};`);
      }
    }
  }

  private routeCounts(options: Pick<LogPageOptions, "status" | "host">): Record<"all" | RouteKind, number> {
    const where = buildWhereClause({ status: options.status, host: options.host });
    const rows = this.db
      .prepare(
        `
          SELECT route, COUNT(*) AS count
          FROM request_logs
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
      const route = normalizeRoute(row.route);
      const count = readCount(row);
      counts[route] = count;
      counts.all += count;
    }

    return counts;
  }

  private statusCounts(options: Pick<LogPageOptions, "route" | "host">): StatusLogCounts {
    const where = buildWhereClause({ route: options.route, host: options.host });
    const rows = this.db
      .prepare(
        `
          SELECT
            CASE WHEN ${LOG_STANDALONE_ERROR_SQL} THEN 'error' ELSE 'normal' END AS status_kind,
            COUNT(*) AS count
          FROM request_logs
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
      const status = normalizeLogStatus(row.status_kind);
      const count = readCount(row);
      counts[status] = count;
      counts.all += count;
    }

    return counts;
  }

  private hostCounts(options: Pick<LogPageOptions, "route" | "status">): HostLogCount[] {
    const where = buildWhereClause({ route: options.route, status: options.status });
    const rows = this.db
      .prepare(
        `
          SELECT
            upstream_host AS host,
            COUNT(*) AS total,
            SUM(CASE WHEN route = 'primary' THEN 1 ELSE 0 END) AS primary_count,
            SUM(CASE WHEN route = 'compact' THEN 1 ELSE 0 END) AS compact_count,
            SUM(CASE WHEN route = 'claude' THEN 1 ELSE 0 END) AS claude_count
          FROM request_logs
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

  private prunePersistedEntries(): void {
    if (this.maxPersistedEntries === null) {
      return;
    }

    this.db
      .prepare(
        `
          DELETE FROM request_logs
          WHERE id <= COALESCE((
            SELECT id
            FROM request_logs
            ORDER BY id DESC
            LIMIT 1 OFFSET ?
          ), 0)
        `
      )
      .run(this.maxPersistedEntries);
  }

  private prunePersistedStorage(): void {
    if (this.maxDatabaseBytes === null) {
      return;
    }

    try {
      let passes = 0;
      while (
        this.databaseFootprintBytes() > this.maxDatabaseBytes &&
        passes < STORAGE_PRUNE_MAX_PASSES
      ) {
        const rowCount = this.persistedRowCount();
        if (rowCount <= 1) {
          this.reclaimSqliteStorage();
          return;
        }

        const rowsToDelete = Math.min(
          rowCount - 1,
          Math.max(
            STORAGE_PRUNE_MIN_DELETE_ROWS,
            Math.ceil(rowCount * STORAGE_PRUNE_DELETE_FRACTION)
          )
        );
        this.deleteOldestPersistedRows(rowsToDelete);
        this.reclaimSqliteStorage();
        passes += 1;
      }
    } catch (error) {
      console.error(
        `Failed to prune request log database below ${this.maxDatabaseBytes} bytes.`,
        error
      );
    }
  }

  private persistedRowCount(): number {
    return readCount(this.db.prepare("SELECT COUNT(*) AS count FROM request_logs").get());
  }

  private deleteOldestPersistedRows(limit: number): void {
    this.db
      .prepare(
        `
          DELETE FROM request_logs
          WHERE id IN (
            SELECT id
            FROM request_logs
            ORDER BY id ASC
            LIMIT ?
          )
        `
      )
      .run(limit);
  }

  private reclaimSqliteStorage(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.exec("VACUUM;");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  private databaseFootprintBytes(): number {
    return sumExistingFileSizes([
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`
    ]);
  }
}

function sumExistingFileSizes(paths: string[]): number {
  let total = 0;

  for (const filePath of paths) {
    if (existsSync(filePath)) {
      total += statSync(filePath).size;
    }
  }

  return total;
}

function normalizeMaxDatabaseBytes(value: number | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_MAX_LOG_DATABASE_BYTES;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function normalizeMaxPersistedEntries(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}
