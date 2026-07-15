import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  HostLogCount,
  LogBodyPurgeResult,
  LogPersistenceHealth,
  RequestLogEntry,
  RequestLogPage,
  RouteKind,
  StatusLogCounts
} from "../shared/types.js";
import {
  buildFacetWhereClause,
  buildWhereClause,
  type LogPageOptions,
  normalizeLogStatus,
  normalizeRoute,
  providerCountsFromRouteCounts,
  readCount,
  readCaptureStatus,
  readNullableNumber,
  rowToLogEntry
} from "./logger-helpers.js";
import {
  LOG_FACET_REBUILD_SQL,
  LOG_FACET_SCHEMA_SQL,
  LOG_TABLE_SQL,
  MIGRATION_COLUMNS,
  RECENT_LOG_FIELDS
} from "./logger-schema.js";
import { extractResponseModelFromText } from "./response-model.js";

export interface RequestLoggerOptions {
  maxDatabaseBytes?: number;
  maxPersistedEntries?: number;
  deferStoragePrune?: boolean;
}

export const DEFAULT_MAX_LOG_DATABASE_BYTES = 1024 * 1024 * 1024;

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

  private maxDatabaseBytes: number | null;

  private closed = false;

  private readonly deferStoragePrune: boolean;

  private scheduledStoragePrune: NodeJS.Immediate | null = null;

  private storagePruneInProgress = false;

  private persistErrorCount = 0;

  private lastPersistError: string | null = null;

  private lastPersistErrorAt: string | null = null;

  private sizeWarningIssued = false;

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
    this.deferStoragePrune = options.deferStoragePrune === true;
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(LOG_TABLE_SQL);
    this.migratePersistedSchema();
    this.ensureFacetSummary();
    this.reconcileInterruptedCaptures();
    this.backfillResponseModels();
    this.prunePersistedEntries();
    if (this.deferStoragePrune) {
      this.checkDatabaseSize();
    } else {
      this.prunePersistedStorage();
    }
  }

  configure(options: { keepRecent: number; maxDatabaseBytes: number }): void {
    this.keepRecent = options.keepRecent;
    this.maxDatabaseBytes = normalizeMaxDatabaseBytes(options.maxDatabaseBytes);
    this.sizeWarningIssued = false;
    this.requestStoragePrune();
    this.checkDatabaseSize();
  }

  getDatabasePath(): string {
    return this.databasePath;
  }

  getPersistenceHealth(): LogPersistenceHealth {
    return {
      database_path: this.databasePath,
      persist_error_count: this.persistErrorCount,
      last_persist_error: this.lastPersistError,
      last_persist_error_at: this.lastPersistErrorAt
    };
  }

  add(entry: RequestLogEntry): void {
    try {
      this.db
        .prepare(
          `
            INSERT INTO request_logs (
              time,
              completed_at,
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
              client_response_body,
              body_status,
              compact_response_normalized,
              compact_response_normalize_reason,
              compact_response_synthetic_source,
              source_model,
              target_model,
              response_model,
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
              error_summary,
              capture_path,
              capture_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          entry.time,
          entry.completed_at,
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
          entry.client_response_body,
          entry.body_status,
          entry.compact_response_normalized ? 1 : 0,
          entry.compact_response_normalize_reason,
          entry.compact_response_synthetic_source,
          entry.source_model,
          entry.target_model,
          entry.response_model,
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
          entry.error_summary,
          entry.capture_path,
          entry.capture_status
      );
      this.prunePersistedEntries();
      this.requestStoragePrune();
      this.checkDatabaseSize();
    } catch (error) {
      this.recordPersistenceFailure("persist request log", error);
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
    const total = this.facetTotal(options);
    const allTotal = this.facetTotal({});
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

  getByRequestId(requestId: string):
    | { status: "found"; entry: RequestLogEntry }
    | { status: "not_found" }
    | { status: "multiple" } {
    const rows = (
      this.db
        .prepare(
          `
            SELECT ${RECENT_LOG_FIELDS}
            FROM request_logs
            WHERE request_id = ?
            LIMIT 2
          `
        )
        .all(requestId) as Array<Record<string, unknown>>
    ).map(rowToLogEntry);

    if (rows.length === 0) {
      return { status: "not_found" };
    }
    if (rows.length > 1) {
      return { status: "multiple" };
    }
    return { status: "found", entry: rows[0] };
  }

  getCaptureByRequestId(requestId: string):
    | {
        status: "found";
        capturePath: string | null;
        captureStatus: RequestLogEntry["capture_status"];
      }
    | { status: "not_found" }
    | { status: "multiple" } {
    const rows = this.db
      .prepare(
        `
          SELECT capture_path, capture_status
          FROM request_logs
          WHERE request_id = ?
          LIMIT 2
        `
      )
      .all(requestId) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      return { status: "not_found" };
    }
    if (rows.length > 1) {
      return { status: "multiple" };
    }

    return {
      status: "found",
      capturePath: typeof rows[0].capture_path === "string" ? rows[0].capture_path : null,
      captureStatus: readCaptureStatus(rows[0].capture_status)
    };
  }

  purgeStoredBodies(): LogBodyPurgeResult {
    const databaseBytesBefore = this.databaseFootprintBytes();
    const rowCountBefore = this.persistedRowCount();
    const rowsCleared = this.clearPersistedBodies();
    if (rowsCleared > 0) {
      this.reclaimSqliteStorage();
    }

    return {
      rows_cleared: rowsCleared,
      row_count_before: rowCountBefore,
      row_count_after: this.persistedRowCount(),
      database_bytes_before: databaseBytesBefore,
      database_bytes_after: this.databaseFootprintBytes()
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.scheduledStoragePrune) {
      clearImmediate(this.scheduledStoragePrune);
      this.scheduledStoragePrune = null;
    }
    this.db.close();
  }

  private requestStoragePrune(): void {
    if (this.maxDatabaseBytes === null) {
      return;
    }

    if (!this.deferStoragePrune) {
      this.prunePersistedStorage();
      return;
    }

    if (this.closed || this.scheduledStoragePrune || this.storagePruneInProgress) {
      return;
    }

    this.scheduledStoragePrune = setImmediate(() => {
      this.scheduledStoragePrune = null;

      if (this.closed || this.storagePruneInProgress) {
        return;
      }

      this.storagePruneInProgress = true;
      try {
        this.prunePersistedStorage();
      } finally {
        this.storagePruneInProgress = false;
      }
    });
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

    this.reconcileBodyStatuses();
    this.ensureRequestIdIndex();
  }

  private reconcileBodyStatuses(): void {
    this.db
      .prepare(
        `
          UPDATE request_logs
          SET body_status = 'present'
          WHERE (
            incoming_request_body IS NOT NULL OR
            upstream_request_body IS NOT NULL OR
            upstream_response_body IS NOT NULL OR
            client_response_body IS NOT NULL
          )
          AND body_status <> 'present'
        `
      )
      .run();
    this.db
      .prepare(
        `
          UPDATE request_logs
          SET body_status = 'none'
          WHERE incoming_request_body IS NULL
            AND upstream_request_body IS NULL
            AND upstream_response_body IS NULL
            AND client_response_body IS NULL
            AND body_status NOT IN ('none', 'purged')
        `
      )
      .run();
  }

  private ensureFacetSummary(): void {
    this.db.exec(LOG_FACET_SCHEMA_SQL);
    const persistedTotal = readCount(
      this.db.prepare("SELECT COUNT(*) AS count FROM request_logs").get()
    );
    const facetTotal = this.facetTotal({});
    if (facetTotal === persistedTotal) {
      return;
    }

    this.db.exec("BEGIN");
    try {
      this.db.exec(LOG_FACET_REBUILD_SQL);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureRequestIdIndex(): void {
    const indexes = this.db.prepare("PRAGMA index_list(request_logs)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const requestIdIndex = indexes.find((index) => index.name === "idx_request_logs_request_id");
    if (requestIdIndex?.unique === 1) {
      this.db.exec("DROP INDEX idx_request_logs_request_id;");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id);"
    );
  }

  private backfillResponseModels(): void {
    const rows = this.db
      .prepare(
        `
          SELECT id, upstream_response_body, client_response_body
          FROM request_logs
          WHERE response_model IS NULL
            AND (
              (upstream_response_body IS NOT NULL AND length(upstream_response_body) > 0) OR
              (client_response_body IS NOT NULL AND length(client_response_body) > 0)
            )
        `
      )
      .all() as Array<{
        id: number;
        upstream_response_body: string | null;
        client_response_body: string | null;
      }>;

    if (rows.length === 0) {
      return;
    }

    const update = this.db.prepare("UPDATE request_logs SET response_model = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const responseModel =
          extractResponseModelFromText(row.upstream_response_body ?? "") ??
          extractResponseModelFromText(row.client_response_body ?? "");
        if (responseModel) {
          update.run(responseModel, row.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.recordPersistenceFailure("backfill response models", error);
      console.error(`Failed to backfill response models in ${this.databasePath}.`, error);
    }
  }

  private reconcileInterruptedCaptures(): void {
    this.db
      .prepare(
        `
          UPDATE request_logs
          SET capture_path = NULL, capture_status = 'none'
          WHERE capture_status = 'pending'
        `
      )
      .run();
  }

  private routeCounts(options: Pick<LogPageOptions, "status" | "host">): Record<"all" | RouteKind, number> {
    const where = buildFacetWhereClause({ status: options.status, host: options.host });
    const rows = this.db
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
      const route = normalizeRoute(row.route);
      const count = readCount(row);
      counts[route] = count;
      counts.all += count;
    }

    return counts;
  }

  private statusCounts(options: Pick<LogPageOptions, "route" | "host">): StatusLogCounts {
    const where = buildFacetWhereClause({ route: options.route, host: options.host });
    const rows = this.db
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
      const status = normalizeLogStatus(row.status_kind);
      const count = readCount(row);
      counts[status] = count;
      counts.all += count;
    }

    return counts;
  }

  private hostCounts(options: Pick<LogPageOptions, "route" | "status">): HostLogCount[] {
    const where = buildFacetWhereClause({ route: options.route, status: options.status });
    const rows = this.db
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

  private facetTotal(options: Pick<LogPageOptions, "route" | "status" | "host">): number {
    const where = buildFacetWhereClause(options);
    return readCount(
      this.db
        .prepare(`SELECT COALESCE(SUM(count), 0) AS count FROM request_log_facets ${where.sql}`)
        .get(...where.params)
    );
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
      if (this.databaseFootprintBytes() > this.maxDatabaseBytes) {
        const rowsCleared = this.clearPersistedBodies();
        if (rowsCleared > 0) {
          this.reclaimSqliteStorage();
        }
      }

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
      this.recordPersistenceFailure("prune request log database", error);
      console.error(
        `Failed to prune request log database below ${this.maxDatabaseBytes} bytes.`,
        error
      );
    }
  }

  private persistedRowCount(): number {
    return readCount(this.db.prepare("SELECT COUNT(*) AS count FROM request_logs").get());
  }

  private clearPersistedBodies(): number {
    const result = this.db
      .prepare(
        `
          UPDATE request_logs
          SET
            incoming_request_body = NULL,
            upstream_request_body = NULL,
            upstream_response_body = NULL,
            client_response_body = NULL,
            body_status = 'purged'
          WHERE incoming_request_body IS NOT NULL
            OR upstream_request_body IS NOT NULL
            OR upstream_response_body IS NOT NULL
            OR client_response_body IS NOT NULL
        `
      )
      .run();
    return Number(result.changes);
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

  private recordPersistenceFailure(operation: string, error: unknown): void {
    this.persistErrorCount += 1;
    this.lastPersistError = `${operation}: ${errorSummary(error)}`;
    this.lastPersistErrorAt = new Date().toISOString();
  }

  markCapturePurged(capturePath: string): void {
    try {
      this.db
        .prepare(
          "UPDATE request_logs SET capture_path = NULL, capture_status = 'purged' WHERE capture_path = ?"
        )
        .run(capturePath);
    } catch (error) {
      this.recordPersistenceFailure("mark capture purged", error);
    }
  }

  markCapturePurgedByRequestId(requestId: string): void {
    try {
      this.db
        .prepare(
          "UPDATE request_logs SET capture_path = NULL, capture_status = 'purged' WHERE request_id = ?"
        )
        .run(requestId);
    } catch (error) {
      this.recordPersistenceFailure("mark request capture purged", error);
    }
  }

  updateCapture(
    requestId: string,
    capturePath: string | null,
    captureStatus: "none" | "present"
  ): void {
    try {
      this.db
        .prepare(
          "UPDATE request_logs SET capture_path = ?, capture_status = ? WHERE request_id = ?"
        )
        .run(capturePath, captureStatus, requestId);
    } catch (error) {
      this.recordPersistenceFailure("update request capture", error);
    }
  }

  private checkDatabaseSize(): void {
    if (this.sizeWarningIssued) {
      return;
    }
    const sizeBytes = this.databaseFootprintBytes();
    const oneGB = 1024 * 1024 * 1024;
    if (sizeBytes >= oneGB) {
      console.warn(
        `[CompactGate] WARNING: SQLite database has reached ${(sizeBytes / oneGB).toFixed(2)} GB. ` +
          "Reduce logging.max_database_bytes or disable logging.persist_body; " +
          "use logging.capture_dir for file-based diagnostics."
      );
      this.sizeWarningIssued = true;
    }
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

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
