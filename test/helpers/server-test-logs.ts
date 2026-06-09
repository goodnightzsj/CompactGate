import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import type { RequestLogEntry, RequestLogPage } from "../../src/shared/types.js";

export async function sendCompactRequest(baseUrl: string, model: string) {
  const response = await fetch(`${baseUrl}/v1/responses/compact`, {
    method: "POST",
    body: JSON.stringify({ model, input: "sensitive prompt" }),
    headers: { "content-type": "application/json" }
  });

  expect(response.status).toBe(200);
}

export async function fetchRecentLogs(baseUrl: string) {
  return (await fetchLogPage(baseUrl)).logs;
}

export async function waitForLogEntry(
  baseUrl: string,
  predicate: (entry: RequestLogEntry) => boolean
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const match = (await fetchRecentLogs(baseUrl)).find(predicate);
    if (match) {
      return match;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const logs = await fetchRecentLogs(baseUrl);
  const match = logs.find(predicate);
  if (!match) {
    throw new Error("Expected log entry was not recorded.");
  }

  return match;
}

export async function fetchLogPage(baseUrl: string, query = "") {
  const response = await fetch(`${baseUrl}/api/logs/recent${query}`);
  const body = await response.json();
  return body as RequestLogPage;
}

export function readLogCount(databasePath: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM request_logs").get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
}

export function seedLegacyLogDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE request_logs (
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
      CREATE INDEX idx_request_logs_id ON request_logs(id DESC);
    `);
    db.prepare(
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
    ).run(
      new Date().toISOString(),
      "compact",
      "POST",
      "/v1/responses/compact",
      "gpt-5.5",
      "gpt-5.5-openai-compact",
      200,
      42,
      "legacy.example",
      "legacy-request",
      null
    );
  } finally {
    db.close();
  }
}
