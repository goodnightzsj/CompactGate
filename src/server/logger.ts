import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RequestLogEntry, RouteKind } from "../shared/types.js";

const LOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    source_model TEXT,
    target_model TEXT,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    upstream_host TEXT NOT NULL,
    request_id TEXT NOT NULL,
    error_summary TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_request_logs_id ON request_logs(id DESC);
`;

const RECENT_LOG_FIELDS = `
  time,
  route,
  method,
  path,
  source_model,
  target_model,
  status,
  duration_ms,
  upstream_host,
  request_id,
  error_summary
`;

export function resolveLogDatabasePath(configPath: string, overridePath?: string): string {
  if (overridePath && overridePath.trim().length > 0) {
    return path.resolve(overridePath);
  }

  const configBaseName = path.basename(configPath, path.extname(configPath));
  return path.join(path.dirname(configPath), `${configBaseName}-logs.sqlite`);
}

export class RequestLogger {
  private entries: RequestLogEntry[] = [];

  private readonly db: DatabaseSync;

  private closed = false;

  constructor(
    private keepRecent: number,
    private readonly databasePath: string
  ) {
    const resolvedPath = path.resolve(databasePath);
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.databasePath = resolvedPath;
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(LOG_TABLE_SQL);
    this.prunePersisted();
    this.reloadRecent();
  }

  resize(keepRecent: number): void {
    this.keepRecent = keepRecent;
    this.prunePersisted();
    this.reloadRecent();
  }

  add(entry: RequestLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.keepRecent) {
      this.entries = this.entries.slice(-this.keepRecent);
    }

    try {
      this.db
        .prepare(
          `
            INSERT INTO request_logs (
              time,
              route,
              method,
              path,
              source_model,
              target_model,
              status,
              duration_ms,
              upstream_host,
              request_id,
              error_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          entry.time,
          entry.route,
          entry.method,
          entry.path,
          entry.source_model,
          entry.target_model,
          entry.status,
          entry.duration_ms,
          entry.upstream_host,
          entry.request_id,
          entry.error_summary
        );
      this.prunePersisted();
    } catch (error) {
      console.error(`Failed to persist request log to ${this.databasePath}.`, error);
    }
  }

  recent(route?: RouteKind): RequestLogEntry[] {
    const entries = route ? this.entries.filter((entry) => entry.route === route) : this.entries;
    return [...entries].reverse();
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.db.close();
  }

  private reloadRecent(): void {
    const rows = this.db
      .prepare(
        `
          SELECT ${RECENT_LOG_FIELDS}
          FROM request_logs
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(this.keepRecent) as Array<Record<string, unknown>>;
    this.entries = rows
      .map((row) => ({
        time: String(row.time),
        route: row.route as RouteKind,
        method: String(row.method),
        path: String(row.path),
        source_model: readNullableString(row.source_model),
        target_model: readNullableString(row.target_model),
        status: Number(row.status),
        duration_ms: Number(row.duration_ms),
        upstream_host: String(row.upstream_host),
        request_id: String(row.request_id),
        error_summary: readNullableString(row.error_summary)
      }))
      .reverse();
  }

  private prunePersisted(): void {
    this.db
      .prepare(
        `
          DELETE FROM request_logs
          WHERE id NOT IN (
            SELECT id
            FROM request_logs
            ORDER BY id DESC
            LIMIT ?
          )
        `
      )
      .run(this.keepRecent);
  }
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
