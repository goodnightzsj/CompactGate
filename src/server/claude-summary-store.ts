import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SUMMARY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS claude_summaries (
    cache_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    source_model TEXT,
    message_count INTEGER NOT NULL,
    summary TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_claude_summaries_last_used ON claude_summaries(last_used_at DESC);
`;

const MAX_PERSISTED_SUMMARIES = 500;

export interface ClaudeSummaryRecord {
  cacheKey: string;
  messageCount: number;
  sourceModel: string | null;
  summary: string;
}

export function resolveClaudeSummaryDatabasePath(configPath: string): string {
  const configBaseName = path.basename(configPath, path.extname(configPath));
  return path.resolve(path.dirname(configPath), `${configBaseName}-claude-summaries.sqlite`);
}

export class ClaudeSummaryStore {
  private readonly db: DatabaseSync;

  private closed = false;

  constructor(databasePath: string) {
    const resolvedPath = path.resolve(databasePath);
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SUMMARY_TABLE_SQL);
  }

  get(cacheKey: string): ClaudeSummaryRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT cache_key, source_model, message_count, summary
          FROM claude_summaries
          WHERE cache_key = ?
        `
      )
      .get(cacheKey) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE claude_summaries SET last_used_at = ? WHERE cache_key = ?")
      .run(now, cacheKey);

    return {
      cacheKey: String(row.cache_key),
      messageCount: Number(row.message_count),
      sourceModel: readNullableString(row.source_model),
      summary: String(row.summary)
    };
  }

  put(record: ClaudeSummaryRecord): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
          INSERT INTO claude_summaries (
            cache_key,
            created_at,
            last_used_at,
            source_model,
            message_count,
            summary
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            last_used_at = excluded.last_used_at,
            source_model = excluded.source_model,
            message_count = excluded.message_count,
            summary = excluded.summary
        `
      )
      .run(
        record.cacheKey,
        now,
        now,
        record.sourceModel,
        record.messageCount,
        record.summary
      );
    this.prune();
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.db.close();
  }

  private prune(): void {
    this.db
      .prepare(
        `
          DELETE FROM claude_summaries
          WHERE cache_key NOT IN (
            SELECT cache_key
            FROM claude_summaries
            ORDER BY last_used_at DESC
            LIMIT ?
          )
        `
      )
      .run(MAX_PERSISTED_SUMMARIES);
  }
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
