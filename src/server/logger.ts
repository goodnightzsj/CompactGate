import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  HostLogCount,
  LogBodyPurgeResult,
  LogPersistenceHealth,
  LogStatsSnapshot,
  RequestLogEntry,
  RequestLogPage,
  RouteKind,
  StatusLogCounts
} from "../shared/types.js";
import {
  buildFacetWhereClause,
  buildWhereClause,
  type LogPageOptions,
  LOG_STANDALONE_ERROR_SQL,
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
  LOG_FACET_CLASSIFICATION_VERSION,
  LOG_FACET_SCHEMA_SQL,
  LOG_INTERNAL_STATE_SCHEMA_SQL,
  LOG_TABLE_SQL,
  MIGRATION_COLUMNS,
  PROVIDER_STATE_BINDING_SCHEMA_SQL,
  PROVIDER_STATE_RECOVERY_EVIDENCE_SCHEMA_SQL,
  RECENT_LOG_FIELDS
} from "./logger-schema.js";
import { readLogStats, type LogStatsOptions } from "./logger-analytics.js";
import type { ProviderStateBinding } from "./provider-state-binding.js";
import { extractResponseModelFromText } from "./response-model.js";

export interface RequestLoggerOptions {
  maxDatabaseBytes?: number;
  deferStoragePrune?: boolean;
}

export const DEFAULT_MAX_LOG_DATABASE_BYTES = 1024 * 1024 * 1024;

const STORAGE_PRUNE_DELETE_FRACTION = 0.1;
/** Ceiling on one pass's delete, so a wildly over-cap database still keeps recent rows. */
const STORAGE_PRUNE_MAX_DELETE_FRACTION = 0.9;
const STORAGE_PRUNE_MIN_DELETE_ROWS = 100;
const STORAGE_PRUNE_MAX_PASSES = 20;
/** Under SQLite's bound-parameter ceiling, with room to spare on older builds. */
const CAPTURE_PURGE_CHUNK_SIZE = 400;
const PROVIDER_STATE_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROVIDER_STATE_BINDINGS = 8_192;
const MAX_PROVIDER_STATE_RECOVERY_EVIDENCE = 8_192;
const PROVIDER_STATE_EXPIRY_SWEEP_INTERVAL_MS = 60_000;
const DATABASE_SIZE_CHECK_INTERVAL_MS = 30_000;
const RESPONSE_MODEL_BACKFILL_BATCH_ROWS = 200;

/**
 * Rows whose response_model_source is derivable as 'target_fallback'.
 * Deliberately kept as one fragment reused by both the SET and the WHERE: the
 * WHERE's `NOT (...)` form is NOT the same as `response_model_source <> CASE`,
 * because `stream_outcome IS NULL AND request_type = 'stream'` makes this
 * expression SQL NULL, so `NOT (NULL)` is falsy and those rows are left alone.
 */
const RESPONSE_MODEL_TARGET_FALLBACK_SQL = `status >= 200 AND status < 300
  AND error_summary IS NULL
  AND (
    stream_outcome = 'success' OR
    (stream_outcome IS NULL AND request_type <> 'stream')
  )
  AND target_model IS NOT NULL`;

const RESPONSE_MODEL_SOURCE_CASE_SQL = `CASE
  WHEN response_model IS NOT NULL THEN 'upstream'
  WHEN ${RESPONSE_MODEL_TARGET_FALLBACK_SQL}
  THEN 'target_fallback'
  ELSE 'unavailable'
END`;

export function resolveLogDatabasePath(configPath: string): string {
  const configBaseName = path.basename(configPath, path.extname(configPath));
  return path.resolve(path.dirname(configPath), `${configBaseName}-logs.sqlite`);
}

export class RequestLogger {
  private readonly db: DatabaseSync;

  private readonly databasePath: string;

  private maxDatabaseBytes: number | null;

  private closed = false;

  private readonly deferStoragePrune: boolean;

  private scheduledStoragePrune: NodeJS.Immediate | null = null;

  private storagePruneInProgress = false;

  private persistErrorCount = 0;

  private lastPersistError: string | null = null;

  private lastPersistErrorAt: string | null = null;

  private sizeWarningIssued = false;

  private lastProviderStateSweepAt = 0;

  private lastDatabaseSizeCheckAt = 0;

  private cachedAddStatement: StatementSync | null = null;

  private cachedPortabilityStatement: StatementSync | null = null;

  constructor(
    private keepRecent: number,
    databasePath: string,
    options: RequestLoggerOptions = {}
  ) {
    const resolvedPath = path.resolve(databasePath);
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.databasePath = resolvedPath;
    this.maxDatabaseBytes = normalizeMaxDatabaseBytes(options.maxDatabaseBytes);
    this.deferStoragePrune = options.deferStoragePrune === true;
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(LOG_TABLE_SQL);
    this.db.exec(PROVIDER_STATE_BINDING_SCHEMA_SQL);
    this.db.exec(PROVIDER_STATE_RECOVERY_EVIDENCE_SCHEMA_SQL);
    this.migratePersistedSchema();
    this.ensureFacetSummary();
    this.reconcileInterruptedCaptures();
    this.backfillResponseModels();
    this.backfillResponseModelSources();
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
    // An explicit reconfigure is an operator action, so let its size check run now
    // rather than waiting out the sampling interval.
    this.lastDatabaseSizeCheckAt = 0;
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

  findProviderStateBinding(identityHashes: string[], now = Date.now()): ProviderStateBinding | null {
    if (identityHashes.length === 0) {
      return null;
    }

    this.sweepExpiredProviderState(now);
    const query = this.db.prepare(`
      SELECT state_domain_id, profile_id, generation, expires_at
      FROM provider_state_bindings
      WHERE identity_hash = ? AND expires_at > ?
    `);
    for (const identityHash of identityHashes) {
      const row = query.get(identityHash, now) as Record<string, unknown> | undefined;
      if (row) {
        return {
          stateDomainId: String(row.state_domain_id),
          profileId: String(row.profile_id),
          generation: Number(row.generation),
          expiresAt: Number(row.expires_at)
        };
      }
    }
    return null;
  }

  rememberProviderStateBinding(
    identityHashes: string[],
    binding: Omit<ProviderStateBinding, "expiresAt">,
    now = Date.now(),
    version = now
  ): boolean {
    if (identityHashes.length === 0) {
      return false;
    }

    const expiresAt = now + PROVIDER_STATE_BINDING_TTL_MS;
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      const upsert = this.db.prepare(`
        INSERT INTO provider_state_bindings (
          identity_hash, state_domain_id, profile_id, generation, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity_hash) DO UPDATE SET
          state_domain_id = excluded.state_domain_id,
          profile_id = excluded.profile_id,
          generation = excluded.generation,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
        WHERE excluded.generation > provider_state_bindings.generation
          OR (
            excluded.generation = provider_state_bindings.generation AND
            excluded.updated_at >= provider_state_bindings.updated_at
          )
      `);
      for (const identityHash of identityHashes) {
        upsert.run(
          identityHash,
          binding.stateDomainId,
          binding.profileId,
          binding.generation,
          expiresAt,
          version
        );
      }
      this.db.prepare("DELETE FROM provider_state_bindings WHERE expires_at <= ?").run(now);
      this.db.prepare(`
        DELETE FROM provider_state_bindings
        WHERE identity_hash IN (
          SELECT identity_hash
          FROM provider_state_bindings
          ORDER BY updated_at DESC, identity_hash DESC
          LIMIT -1 OFFSET ?
        )
      `).run(MAX_PROVIDER_STATE_BINDINGS);
      this.db.exec("COMMIT;");
      return true;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original SQLite failure.
      }
      this.recordPersistenceFailure("persist provider-state binding", error);
      console.error(`Failed to persist provider-state binding to ${this.databasePath}.`, error);
      return false;
    }
  }

  hasProviderStateRecoveryEvidence(evidenceKey: string, now = Date.now()): boolean {
    this.sweepExpiredProviderState(now);
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM provider_state_recovery_evidence
      WHERE evidence_key = ? AND expires_at > ?
    `).get(evidenceKey, now));
  }

  /**
   * Housekeeping only, so it is rate-limited rather than run per read. Both read
   * paths already filter on `expires_at > now`, so correctness never depended on
   * the delete — but each one was a WAL write transaction plus an fsync, twice per
   * primary request, on the hot path.
   */
  private sweepExpiredProviderState(now: number): void {
    if (now - this.lastProviderStateSweepAt < PROVIDER_STATE_EXPIRY_SWEEP_INTERVAL_MS) {
      return;
    }

    this.lastProviderStateSweepAt = now;
    try {
      this.db.prepare("DELETE FROM provider_state_bindings WHERE expires_at <= ?").run(now);
      this.db.prepare("DELETE FROM provider_state_recovery_evidence WHERE expires_at <= ?").run(now);
    } catch (error) {
      this.recordPersistenceFailure("sweep expired provider state", error);
    }
  }

  rememberProviderStateRecoveryEvidence(
    evidenceKey: string,
    kind: "target_health" | "legacy_failure",
    ttlMs: number,
    now = Date.now()
  ): number {
    const expiresAt = now + ttlMs;
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      this.db.prepare(`
        INSERT INTO provider_state_recovery_evidence (
          evidence_key, evidence_kind, observation_count, observed_at, expires_at
        ) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(evidence_key) DO UPDATE SET
          evidence_kind = excluded.evidence_kind,
          observation_count = CASE
            WHEN provider_state_recovery_evidence.expires_at > excluded.observed_at
              THEN provider_state_recovery_evidence.observation_count + 1
            ELSE 1
          END,
          observed_at = excluded.observed_at,
          expires_at = excluded.expires_at
      `).run(evidenceKey, kind, now, expiresAt);
      const row = this.db.prepare(`
        SELECT observation_count
        FROM provider_state_recovery_evidence
        WHERE evidence_key = ?
      `).get(evidenceKey) as Record<string, unknown> | undefined;
      this.db.prepare("DELETE FROM provider_state_recovery_evidence WHERE expires_at <= ?").run(now);
      this.db.prepare(`
        DELETE FROM provider_state_recovery_evidence
        WHERE evidence_key IN (
          SELECT evidence_key
          FROM provider_state_recovery_evidence
          ORDER BY observed_at DESC, evidence_key DESC
          LIMIT -1 OFFSET ?
        )
      `).run(MAX_PROVIDER_STATE_RECOVERY_EVIDENCE);
      this.db.exec("COMMIT;");
      return Number(row?.observation_count ?? 1);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original SQLite failure.
      }
      this.recordPersistenceFailure("persist provider-state recovery evidence", error);
      console.error(`Failed to persist provider-state recovery evidence to ${this.databasePath}.`, error);
      return 0;
    }
  }

  add(entry: RequestLogEntry): void {
    try {
      // One transaction for both statements: the UPDATE below targets
      // `last_insert_rowid()`, so a failure between them would leave a row whose
      // portability payload is silently missing rather than absent-by-design.
      this.db.exec("BEGIN IMMEDIATE;");
      this.addStatement()
        .run(
          entry.time,
          entry.completed_at,
          entry.route,
          entry.compaction_mode ?? null,
          entry.compaction_detection_source ?? null,
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
          entry.compaction_diagnostics ? JSON.stringify(entry.compaction_diagnostics) : null,
          entry.source_model,
          entry.target_model,
          entry.response_model,
          entry.response_model_source ?? (entry.response_model ? "upstream" : "unavailable"),
          entry.status,
          entry.upstream_status ?? null,
          entry.stream_terminal_event ?? null,
          entry.client_disconnect_phase ?? "none",
          entry.stream_outcome ?? null,
          entry.stream_oversized_event_count ?? 0,
          entry.upstream_response_truncated ? 1 : 0,
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
          entry.key_name,
          entry.request_id,
          entry.error_summary,
          entry.capture_path,
          entry.capture_status
      );
      if (entry.provider_state_portability) {
        this.portabilityStatement()
          .run(JSON.stringify(entry.provider_state_portability));
      }
      this.db.exec("COMMIT;");
      // Both prunes open their own write transactions, so they must run after the
      // commit above rather than nested inside it.
      this.requestStoragePrune();
      this.checkDatabaseSize();
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original SQLite failure.
      }
      this.recordPersistenceFailure("persist request log", error);
      console.error(`Failed to persist request log to ${this.databasePath}.`, error);
    }
  }

  /**
   * Prepared once and reused: `add` runs on every proxied request, and re-parsing
   * a 51-column INSERT per call is pure overhead on the hot path. Cached lazily so
   * constructing a logger still costs nothing until the first write, and because
   * `migratePersistedSchema` must have added its columns before the statement is
   * compiled against them.
   */
  private addStatement(): StatementSync {
    this.cachedAddStatement ??= this.db.prepare(`
      INSERT INTO request_logs (
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
        incoming_request_body,
        upstream_request_body,
        upstream_response_body,
        client_response_body,
        body_status,
        compact_response_normalized,
        compact_response_normalize_reason,
        compact_response_synthetic_source,
        compaction_diagnostics,
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
        upstream_response_truncated,
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
        key_name,
        request_id,
        error_summary,
        capture_path,
        capture_status
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `);
    return this.cachedAddStatement;
  }

  private portabilityStatement(): StatementSync {
    this.cachedPortabilityStatement ??= this.db.prepare(`
      UPDATE request_logs
      SET provider_state_portability = ?
      WHERE id = last_insert_rowid()
    `);
    return this.cachedPortabilityStatement;
  }

  recent(route?: RouteKind): RequestLogEntry[] {
    return this.recentLogs({ route, limit: this.keepRecent });
  }

  /**
   * The rows without the facet counts. `page()` runs five extra count queries to
   * build the Studio's filter sidebar; a caller that only reads `.logs` paid for
   * all five and discarded them — including the per-compaction protocol lookup and
   * the health probe, which run far more often than anyone opens the log table.
   */
  recentLogs(options: { route?: RouteKind; limit: number; offset?: number }): RequestLogEntry[] {
    return this.queryLogRows(
      { route: options.route },
      Math.max(1, Math.floor(options.limit)),
      options.offset ?? 0
    );
  }

  private queryLogRows(
    options: Omit<LogPageOptions, "limit" | "offset">,
    limit: number,
    offset: number
  ): RequestLogEntry[] {
    const where = buildWhereClause(options);
    return (
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
  }

  page(options: LogPageOptions): RequestLogPage {
    const limit = Math.max(1, Math.floor(options.limit));
    const offset = Number.isSafeInteger(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
    const logs = this.queryLogRows(options, limit, offset);
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

  stats(options: LogStatsOptions): LogStatsSnapshot {
    return readLogStats(this.db, options);
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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_request_logs_capture_path
        ON request_logs(capture_path)
        WHERE capture_path IS NOT NULL;
    `);
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
    this.db.exec(`
      DROP TRIGGER IF EXISTS trg_request_log_facets_insert;
      DROP TRIGGER IF EXISTS trg_request_log_facets_delete;
    `);
    this.db.exec(LOG_FACET_SCHEMA_SQL);
    this.db.exec(LOG_INTERNAL_STATE_SCHEMA_SQL);
    const persistedTotal = readCount(
      this.db.prepare("SELECT COUNT(*) AS count FROM request_logs").get()
    );
    const facetTotal = this.facetTotal({});
    const facetVersionRow = this.db.prepare(
      "SELECT value FROM request_log_internal_state WHERE key = 'facet_classification_version'"
    ).get() as { value?: unknown } | undefined;
    const facetVersion = typeof facetVersionRow?.value === "string" ? facetVersionRow.value : null;
    if (facetTotal === persistedTotal && facetVersion === LOG_FACET_CLASSIFICATION_VERSION) {
      return;
    }

    this.db.exec("BEGIN");
    try {
      this.db.exec(LOG_FACET_REBUILD_SQL);
      this.db.prepare(`
        INSERT INTO request_log_internal_state (key, value)
        VALUES ('facet_classification_version', ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `).run(LOG_FACET_CLASSIFICATION_VERSION);
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

  /**
   * Walked in id-ordered batches rather than read whole. `.all()` pulled *both*
   * stored bodies of every pending row into memory at once, which with
   * `persist_body=true` scales to the database size cap — a startup-time spike
   * measured in the same order as the 1 GiB default. The cursor advances past rows
   * whose extraction found nothing, so a batch cannot repeat; those rows are
   * re-examined on the next startup, which is bounded work and the reason the
   * batch size is small.
   */
  private backfillResponseModels(): void {
    const select = this.db.prepare(
      `
        SELECT id, upstream_response_body, client_response_body
        FROM request_logs
        WHERE response_model IS NULL
          AND id > ?
          AND (
            (upstream_response_body IS NOT NULL AND length(upstream_response_body) > 0) OR
            (client_response_body IS NOT NULL AND length(client_response_body) > 0)
          )
        ORDER BY id
        LIMIT ?
      `
    );
    const update = this.db.prepare("UPDATE request_logs SET response_model = ? WHERE id = ?");
    let cursor = 0;

    try {
      for (;;) {
        const rows = select.all(cursor, RESPONSE_MODEL_BACKFILL_BATCH_ROWS) as Array<{
          id: number;
          upstream_response_body: string | null;
          client_response_body: string | null;
        }>;
        if (rows.length === 0) {
          return;
        }

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
          throw error;
        }
        cursor = rows[rows.length - 1].id;
      }
    } catch (error) {
      this.recordPersistenceFailure("backfill response models", error);
      console.error(`Failed to backfill response models in ${this.databasePath}.`, error);
    }
  }

  private backfillResponseModelSources(): void {
    try {
      this.db.exec("BEGIN");
      this.db
        .prepare(
          `
            UPDATE request_logs
            SET response_model_source = ${RESPONSE_MODEL_SOURCE_CASE_SQL}
            WHERE (response_model IS NOT NULL AND response_model_source <> 'upstream')
              OR (
                response_model IS NULL
                AND ${RESPONSE_MODEL_TARGET_FALLBACK_SQL}
                AND response_model_source <> 'target_fallback'
              )
              OR (
                response_model IS NULL
                AND NOT (${RESPONSE_MODEL_TARGET_FALLBACK_SQL})
                AND response_model_source <> 'unavailable'
              )
          `
        )
        .run();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original persistence failure.
      }
      this.recordPersistenceFailure("backfill response model sources", error);
      console.error(`Failed to backfill response model sources in ${this.databasePath}.`, error);
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

  private routeCounts(options: Pick<LogPageOptions, "status" | "host" | "search">): Record<"all" | RouteKind, number> {
    // Callers pass the whole LogPageOptions, so the counted dimension has to be
    // dropped explicitly rather than relied on being absent from the Pick type.
    const facet = { status: options.status, host: options.host };
    const where = options.search
      ? buildWhereClause({ ...facet, search: options.search })
      : buildFacetWhereClause(facet);
    const rows = this.db
      .prepare(
        `
          SELECT route, ${options.search ? "COUNT(*)" : "SUM(count)"} AS count
          FROM ${options.search ? "request_logs" : "request_log_facets"}
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

  private statusCounts(options: Pick<LogPageOptions, "route" | "host" | "search">): StatusLogCounts {
    const facet = { route: options.route, host: options.host };
    const where = options.search
      ? buildWhereClause({ ...facet, search: options.search })
      : buildFacetWhereClause(facet);
    const statusColumn = options.search
      ? `CASE WHEN ${LOG_STANDALONE_ERROR_SQL} THEN 'error' ELSE 'normal' END`
      : "log_status";
    const rows = this.db
      .prepare(
        `
          SELECT ${statusColumn} AS status_kind, ${options.search ? "COUNT(*)" : "SUM(count)"} AS count
          FROM ${options.search ? "request_logs" : "request_log_facets"}
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

  private hostCounts(options: Pick<LogPageOptions, "route" | "status" | "search">): HostLogCount[] {
    const facet = { route: options.route, status: options.status };
    const where = options.search
      ? buildWhereClause({ ...facet, search: options.search })
      : buildFacetWhereClause(facet);
    const rows = this.db
      .prepare(
        `
          SELECT
            upstream_host AS host,
            ${options.search ? "COUNT(*)" : "SUM(count)"} AS total,
            SUM(CASE WHEN route = 'primary' THEN ${options.search ? "1" : "count"} ELSE 0 END) AS primary_count,
            SUM(CASE WHEN route = 'compact' THEN ${options.search ? "1" : "count"} ELSE 0 END) AS compact_count,
            SUM(CASE WHEN route = 'claude' THEN ${options.search ? "1" : "count"} ELSE 0 END) AS claude_count
          FROM ${options.search ? "request_logs" : "request_log_facets"}
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

  private facetTotal(options: Pick<LogPageOptions, "route" | "status" | "host" | "search">): number {
    const where = options.search
      ? buildWhereClause(options)
      : buildFacetWhereClause(options);
    return readCount(
      this.db
        .prepare(
          `SELECT ${options.search ? "COUNT(*)" : "COALESCE(SUM(count), 0)"} AS count FROM ${options.search ? "request_logs" : "request_log_facets"} ${where.sql}`
        )
        .get(...where.params)
    );
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
      while (passes < STORAGE_PRUNE_MAX_PASSES) {
        // Checkpoint before measuring. The prune runs right after inserts, when
        // the WAL is at its fullest, and the footprint counts it — so a database
        // already under its cap can measure far over it, and the overshoot-based
        // delete below would then throw away rows in proportion to WAL bytes
        // that deleting rows cannot shrink.
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        const footprint = this.databaseFootprintBytes();
        if (footprint <= this.maxDatabaseBytes) {
          return;
        }

        const rowCount = this.persistedRowCount();
        if (rowCount <= 1) {
          this.reclaimSqliteStorage();
          return;
        }

        // Size the delete from how far over the cap we are, so one reclaim does
        // the work. A flat 10% per pass needed up to 20 passes, and every pass
        // ran a VACUUM — which rewrites the whole database file synchronously on
        // `node:sqlite`. At the 1 GiB default that was minutes of blocked event
        // loop, i.e. minutes of stalled proxying, right when the disk is full.
        const overshootFraction = 1 - this.maxDatabaseBytes / footprint;
        const rowsToDelete = Math.min(
          rowCount - 1,
          Math.max(
            STORAGE_PRUNE_MIN_DELETE_ROWS,
            Math.ceil(rowCount * Math.min(
              STORAGE_PRUNE_MAX_DELETE_FRACTION,
              overshootFraction + STORAGE_PRUNE_DELETE_FRACTION
            ))
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
    this.lastPersistError = `${operation}: ${error instanceof Error ? error.message : String(error)}`;
    this.lastPersistErrorAt = new Date().toISOString();
  }

  markCapturePurged(capturePath: string): RequestLogEntry[] {
    return this.markCapturesPurged([capturePath], 1);
  }

  /**
   * Batched on purpose. Doing this one path at a time meant a fresh `prepare` plus
   * a full-column `SELECT` plus another `prepare` and `UPDATE` per file, all
   * synchronous on the event loop — measured 489 ms for 5,000 rows, so lowering
   * `capture_dir_max_bytes` on a large directory froze proxying for seconds.
   * Batching only the SSE frames fixed half of that stall and left this half.
   *
   * `maxEntries` skips the expensive row read entirely when the caller is going to
   * discard the entries and broadcast one snapshot instead: those full-row SELECTs
   * previously ran and were thrown away in exactly the case that hurt most.
   */
  markCapturesPurged(capturePaths: string[], maxEntries: number): RequestLogEntry[] {
    if (capturePaths.length === 0) {
      return [];
    }

    const wantEntries = capturePaths.length <= maxEntries;
    const purged: RequestLogEntry[] = [];
    try {
      // Chunked under SQLite's bound-parameter ceiling, which a 20 GiB directory
      // purge would otherwise blow straight through.
      for (let offset = 0; offset < capturePaths.length; offset += CAPTURE_PURGE_CHUNK_SIZE) {
        const chunk = capturePaths.slice(offset, offset + CAPTURE_PURGE_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const entries = wantEntries
          ? (
            this.db
              .prepare(
                `
                  SELECT ${RECENT_LOG_FIELDS}
                  FROM request_logs
                  WHERE capture_path IN (${placeholders})
                `
              )
              .all(...chunk) as Array<Record<string, unknown>>
          ).map(rowToLogEntry)
          : [];
        const result = this.db
          .prepare(
            `UPDATE request_logs SET capture_path = NULL, capture_status = 'purged' WHERE capture_path IN (${placeholders})`
          )
          .run(...chunk);
        if (Number(result.changes) === 0) {
          continue;
        }
        purged.push(...entries.map((entry) => ({
          ...entry,
          capture_path: null,
          capture_status: "purged" as const
        })));
      }
      return purged;
    } catch (error) {
      this.recordPersistenceFailure("mark captures purged", error);
      return [];
    }
  }

  markCapturePurgedByRequestId(requestId: string): RequestLogEntry | null {
    try {
      const existing = this.getByRequestId(requestId);
      if (existing.status !== "found") {
        return null;
      }
      const result = this.db
        .prepare(
          "UPDATE request_logs SET capture_path = NULL, capture_status = 'purged' WHERE request_id = ?"
        )
        .run(requestId);
      if (Number(result.changes) === 0) {
        return null;
      }
      return {
        ...existing.entry,
        capture_path: null,
        capture_status: "purged"
      };
    } catch (error) {
      this.recordPersistenceFailure("mark request capture purged", error);
      return null;
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

  private checkDatabaseSize(now = Date.now()): void {
    if (this.sizeWarningIssued) {
      return;
    }
    // Rate-limited: this runs on every log insert and each call is three
    // synchronous `statSync` calls (db + -wal + -shm). It only exists to print a
    // one-shot warning, so sampling it costs nothing but the exact moment the
    // warning appears.
    if (now - this.lastDatabaseSizeCheckAt < DATABASE_SIZE_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastDatabaseSizeCheckAt = now;
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
