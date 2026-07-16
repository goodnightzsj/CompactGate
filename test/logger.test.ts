import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_LOG_DATABASE_BYTES,
  RequestLogger
} from "../src/server/logger.js";
import { addLog, emptyUsageMetrics } from "../src/server/proxy-support.js";
import type { RequestLogEntry } from "../src/shared/types.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const clean = cleanup.pop();
    if (clean) {
      await clean();
    }
  }
});

describe("RequestLogger", () => {
  it("defaults the persisted SQLite database cap to 1 GiB", () => {
    expect(DEFAULT_MAX_LOG_DATABASE_BYTES).toBe(1024 * 1024 * 1024);
  });

  it("does not cap persisted SQLite logs by entry count by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(2, databasePath);

    try {
      for (let index = 1; index <= 6; index += 1) {
        logger.add(logEntry(index));
      }

      const recent = logger.recent();
      expect(recent.map((entry) => entry.source_model)).toEqual(["gpt-5.6", "gpt-5.5"]);

      const page = logger.page({ limit: 10, offset: 0 });
      expect(page.all_total).toBe(6);
      expect(page.total).toBe(6);
      expect(page.logs.map((entry) => entry.source_model)).toEqual([
        "gpt-5.6",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.3",
        "gpt-5.2",
        "gpt-5.1"
      ]);
    } finally {
      logger.close();
    }
  });

  it("tracks body lifecycle for new and legacy persisted rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const legacyDb = new DatabaseSync(databasePath);

    try {
      legacyDb.exec(`
        CREATE TABLE request_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          time TEXT NOT NULL,
          route TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          incoming_request_body TEXT,
          source_model TEXT,
          target_model TEXT,
          status INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          upstream_host TEXT NOT NULL,
          request_id TEXT NOT NULL
        );
      `);
      legacyDb
        .prepare(
          `
            INSERT INTO request_logs (
              time,
              route,
              method,
              path,
              incoming_request_body,
              source_model,
              target_model,
              status,
              duration_ms,
              upstream_host,
              request_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          "2026-01-01T00:00:00.000Z",
          "primary",
          "POST",
          "/v1/responses",
          "{\"legacy\":true}",
          "gpt-5.5",
          "gpt-5.5",
          200,
          1,
          "legacy.example",
          "legacy-body"
        );
    } finally {
      legacyDb.close();
    }

    const logger = new RequestLogger(10, databasePath);
    try {
      expect(logger.getByRequestId("legacy-body")).toMatchObject({
        status: "found",
        entry: {
          body_status: "present"
        }
      });

      logger.add(logEntry(1, "{\"new\":true}"));
      logger.add(logEntry(2));

      expect(logger.getByRequestId("request-1")).toMatchObject({
        status: "found",
        entry: {
          body_status: "present"
        }
      });
      expect(logger.getByRequestId("request-2")).toMatchObject({
        status: "found",
        entry: {
          body_status: "none"
        }
      });
    } finally {
      logger.close();
    }
  });

  it("builds facet summaries for existing databases and keeps them updated", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const seedingLogger = new RequestLogger(10, databasePath);

    try {
      seedingLogger.add({
        ...logEntry(1),
        route: "primary",
        upstream_host: "primary.example"
      });
      seedingLogger.add({
        ...logEntry(2),
        status: 500,
        error_summary: "upstream failed"
      });
    } finally {
      seedingLogger.close();
    }

    const legacyDb = new DatabaseSync(databasePath);
    try {
      legacyDb.exec(`
        DROP TRIGGER trg_request_log_facets_insert;
        DROP TRIGGER trg_request_log_facets_delete;
        DROP TABLE request_log_facets;
      `);
    } finally {
      legacyDb.close();
    }

    const logger = new RequestLogger(10, databasePath);
    try {
      expect(logger.page({ limit: 10, offset: 0 })).toMatchObject({
        total: 2,
        all_total: 2,
        counts: {
          all: 2,
          primary: 1,
          compact: 1,
          claude: 0
        },
        status_counts: {
          all: 2,
          normal: 1,
          error: 1
        }
      });
      expect(logger.page({ status: "error", limit: 10, offset: 0 })).toMatchObject({
        total: 1,
        all_total: 2
      });

      logger.add({
        ...logEntry(3),
        route: "claude",
        upstream_host: "claude.example"
      });
      expect(logger.page({ limit: 10, offset: 0 })).toMatchObject({
        total: 3,
        all_total: 3,
        counts: {
          all: 3,
          primary: 1,
          compact: 1,
          claude: 1
        }
      });
    } finally {
      logger.close();
    }
  });

  it("records request start time instead of log write time", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(2, databasePath);
    const startedAtIso = "2026-06-12T04:04:52.000Z";
    const completedAtIso = "2026-06-12T04:05:03.000Z";

    try {
      const entry = addLog(logger, {
        route: "compact",
        req: {
          method: "POST",
          headers: { "user-agent": "CompactGateTest/1.0" }
        } as IncomingMessage,
        url: new URL("http://compactgate.local/v1/responses/compact"),
        status: 200,
        startedAt: performance.now(),
        startedAtIso,
        completedAtIso,
        endpoint: "/responses/compact",
        requestType: "http",
        reasoningEffort: null,
        requestSummary: null,
        incomingRequestBody: Buffer.alloc(0),
        upstreamRequestBody: Buffer.alloc(0),
        upstreamResponseBody: Buffer.from("{}"),
        clientResponseBody: null,
        persistBody: false,
        upstreamHost: "compact.example",
        requestId: "request-start-time",
        sourceModel: "gpt-5.5",
        targetModel: "gpt-5.5-openai-compact",
        firstTokenMs: null,
        usage: emptyUsageMetrics(),
        errorSummary: null,
        compactResponseNormalized: false,
        compactResponseNormalizeReason: null,
        compactResponseSyntheticSource: null,
        capturePath: null,
        captureStatus: "none"
      });

      expect(entry.time).toBe(startedAtIso);
      expect(entry.completed_at).toBe(completedAtIso);
      expect(logger.recent()[0].time).toBe(startedAtIso);
      expect(logger.recent()[0].completed_at).toBe(completedAtIso);
    } finally {
      logger.close();
    }
  });

  it("extracts response model from streamed Responses API events", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(2, databasePath);
    const upstreamResponseBody = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"model\":\"gpt-5.5\",\"status\":\"in_progress\"}}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5.5-2026-04-23\",\"status\":\"completed\"}}",
      ""
    ].join("\n");

    try {
      const entry = addLog(logger, {
        route: "primary",
        req: {
          method: "POST",
          headers: { "user-agent": "CompactGateTest/1.0" }
        } as IncomingMessage,
        url: new URL("http://compactgate.local/v1/responses"),
        status: 200,
        startedAt: performance.now(),
        startedAtIso: "2026-06-12T04:04:52.000Z",
        completedAtIso: "2026-06-12T04:05:03.000Z",
        endpoint: "/responses",
        requestType: "stream",
        reasoningEffort: null,
        requestSummary: null,
        incomingRequestBody: Buffer.alloc(0),
        upstreamRequestBody: Buffer.alloc(0),
        upstreamResponseBody: Buffer.from(upstreamResponseBody),
        clientResponseBody: null,
        persistBody: false,
        upstreamHost: "primary.example",
        requestId: "response-model-stream",
        sourceModel: "gpt-5.5",
        targetModel: "gpt-5.5",
        firstTokenMs: 12,
        usage: emptyUsageMetrics(),
        errorSummary: null,
        compactResponseNormalized: false,
        compactResponseNormalizeReason: null,
        compactResponseSyntheticSource: null,
        capturePath: null,
        captureStatus: "none"
      });

      expect(entry.response_model).toBe("gpt-5.5-2026-04-23");
      expect(logger.recent()[0].response_model).toBe("gpt-5.5-2026-04-23");
    } finally {
      logger.close();
    }
  });

  it("backfills missing response model values from persisted response bodies", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const seedingLogger = new RequestLogger(2, databasePath);

    try {
      seedingLogger.add(logEntry(1, JSON.stringify({ model: "gpt-5.5-actual" })));
    } finally {
      seedingLogger.close();
    }

    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE request_logs SET response_model = NULL").run();
    } finally {
      db.close();
    }

    const reopenedLogger = new RequestLogger(2, databasePath);
    try {
      expect(reopenedLogger.recent()[0].response_model).toBe("gpt-5.5-actual");
    } finally {
      reopenedLogger.close();
    }
  });

  it("exposes request log persistence failures through logger health", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(2, databasePath);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(logger.getPersistenceHealth()).toMatchObject({
        database_path: databasePath,
        persist_error_count: 0,
        last_persist_error: null,
        last_persist_error_at: null
      });

      logger.close();
      logger.add(logEntry(1));

      const health = logger.getPersistenceHealth();
      expect(health.database_path).toBe(databasePath);
      expect(health.persist_error_count).toBe(1);
      expect(health.last_persist_error).toContain("persist request log");
      expect(health.last_persist_error_at).toEqual(expect.any(String));
    } finally {
      consoleError.mockRestore();
      logger.close();
    }
  });

  it("bounds persisted SQLite logs independently from the visible recent window", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");

    const logger = new RequestLogger(2, databasePath, {
      maxPersistedEntries: 4
    });

    try {
      for (let index = 1; index <= 6; index += 1) {
        logger.add(logEntry(index));
      }

      const recent = logger.recent();
      expect(recent.map((entry) => entry.source_model)).toEqual(["gpt-5.6", "gpt-5.5"]);

      const page = logger.page({ limit: 10, offset: 0 });
      expect(page.all_total).toBe(4);
      expect(page.total).toBe(4);
      expect(page.logs.map((entry) => entry.source_model)).toEqual([
        "gpt-5.6",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.3"
      ]);
      expect(page.logs.some((entry) => entry.source_model === "gpt-5.2")).toBe(false);
      expect(page.logs.some((entry) => entry.source_model === "gpt-5.1")).toBe(false);
    } finally {
      logger.close();
    }
  });

  it("prunes existing persisted logs when opening an over-limit database", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const seedingLogger = new RequestLogger(2, databasePath, {
      maxPersistedEntries: 10
    });

    try {
      for (let index = 1; index <= 6; index += 1) {
        seedingLogger.add(logEntry(index));
      }
    } finally {
      seedingLogger.close();
    }

    const reopenedLogger = new RequestLogger(2, databasePath, {
      maxPersistedEntries: 4
    });

    try {
      const page = reopenedLogger.page({ limit: 10, offset: 0 });
      expect(page.all_total).toBe(4);
      expect(page.logs.map((entry) => entry.source_model)).toEqual([
        "gpt-5.6",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.3"
      ]);
    } finally {
      reopenedLogger.close();
    }
  });

  it("purges stored bodies before deleting metadata when the database exceeds the byte cap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const maxDatabaseBytes = 120 * 1024;
    const logger = new RequestLogger(10, databasePath, {
      maxDatabaseBytes
    });

    try {
      for (let index = 1; index <= 6; index += 1) {
        logger.add(logEntry(index, "x".repeat(16 * 1024)));
      }

      const page = logger.page({ limit: 10, offset: 0 });
      expect(page.all_total).toBe(6);
      expect(page.logs[0].source_model).toBe("gpt-5.6");
      expect(page.logs.every((entry) => entry.body_status === "purged")).toBe(true);
      expect(databaseFootprintBytes(databasePath)).toBeLessThanOrEqual(maxDatabaseBytes);

      const db = new DatabaseSync(databasePath);
      try {
        const row = db
          .prepare(
            `
              SELECT
                COUNT(*) AS row_count,
                COUNT(incoming_request_body) AS incoming_body_count,
                COUNT(upstream_request_body) AS upstream_request_body_count,
                COUNT(upstream_response_body) AS upstream_response_body_count,
                COUNT(client_response_body) AS client_response_body_count
              FROM request_logs
            `
          )
          .get() as Record<string, number>;
        expect(row).toMatchObject({
          row_count: 6,
          incoming_body_count: 0,
          upstream_request_body_count: 0,
          upstream_response_body_count: 0,
          client_response_body_count: 0
        });
      } finally {
        db.close();
      }
    } finally {
      logger.close();
    }
  });

  it("purges persisted bodies explicitly without deleting metadata rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(10, databasePath, {
      maxDatabaseBytes: 10 * 1024 * 1024
    });

    try {
      logger.add(logEntry(1, "body-1"));
      logger.add(logEntry(2, "body-2"));
      logger.add(logEntry(3));

      const result = logger.purgeStoredBodies();
      expect(result).toMatchObject({
        rows_cleared: 2,
        row_count_before: 3,
        row_count_after: 3
      });
      expect(result.database_bytes_after).toBeLessThanOrEqual(result.database_bytes_before);
      expect(logger.page({ limit: 10, offset: 0 }).logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ request_id: "request-1", body_status: "purged" }),
          expect.objectContaining({ request_id: "request-2", body_status: "purged" }),
          expect.objectContaining({ request_id: "request-3", body_status: "none" })
        ])
      );

      expect(logger.purgeStoredBodies()).toMatchObject({
        rows_cleared: 0,
        row_count_before: 3,
        row_count_after: 3
      });
    } finally {
      logger.close();
    }
  });

  it("skips startup storage pruning when deferred mode is enabled", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const loggerPrototype = RequestLogger.prototype as unknown as {
      prunePersistedStorage(): void;
    };
    const pruneSpy = vi.spyOn(loggerPrototype, "prunePersistedStorage");
    const logger = new RequestLogger(10, databasePath, {
      maxDatabaseBytes: 1024,
      deferStoragePrune: true
    });

    try {
      expect(pruneSpy).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(pruneSpy).not.toHaveBeenCalled();
    } finally {
      logger.close();
      pruneSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("normalizes unsafe page offsets before querying SQLite", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(3, databasePath);

    try {
      for (let index = 1; index <= 3; index += 1) {
        logger.add(logEntry(index));
      }

      const page = logger.page({ limit: 1, offset: 1e30 });
      expect(page.offset).toBe(0);
      expect(page.logs).toHaveLength(1);
      expect(page.logs[0].source_model).toBe("gpt-5.3");
      expect(page.has_more).toBe(true);
    } finally {
      logger.close();
    }
  });

  it("ignores malformed persisted numeric log fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const initializingLogger = new RequestLogger(3, databasePath);
    initializingLogger.close();

    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(
        `
          INSERT INTO request_logs (
            time,
            route,
            method,
            path,
            endpoint,
            request_type,
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
            total_tokens,
            upstream_host,
            request_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        new Date().toISOString(),
        "primary",
        "POST",
        "/v1/responses",
        "/responses",
        "http",
        200,
        7,
        "0x5",
        "123",
        "0x10",
        "",
        "  ",
        "12.5",
        "-1",
        "10tokens",
        "0x20",
        "legacy.example",
        "legacy-malformed-numbers"
      );
    } finally {
      db.close();
    }

    const reopenedLogger = new RequestLogger(3, databasePath);
    try {
      const [entry] = reopenedLogger.page({ limit: 1, offset: 0 }).logs;
      expect(entry).toMatchObject({
        input_tokens: 123,
        response_model: null,
        first_token_ms: null,
        output_tokens: null,
        cached_input_tokens: null,
        cached_output_tokens: null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        reasoning_tokens: null,
        total_tokens: null
      });
    } finally {
      reopenedLogger.close();
    }
  });

  it("normalizes malformed persisted required numeric log fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const initializingLogger = new RequestLogger(3, databasePath);
    initializingLogger.close();

    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(
        `
          INSERT INTO request_logs (
            time,
            route,
            method,
            path,
            endpoint,
            request_type,
            status,
            duration_ms,
            upstream_host,
            request_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        new Date().toISOString(),
        "primary",
        "POST",
        "/v1/responses",
        "/responses",
        "http",
        "0x1f4",
        "12.5",
        "legacy.example",
        "legacy-malformed-required-numbers"
      );
    } finally {
      db.close();
    }

    const reopenedLogger = new RequestLogger(3, databasePath);
    try {
      const [entry] = reopenedLogger.page({ limit: 1, offset: 0 }).logs;
      expect(entry.status).toBe(0);
      expect(entry.duration_ms).toBe(0);
      expect(Number.isFinite(entry.status)).toBe(true);
      expect(Number.isFinite(entry.duration_ms)).toBe(true);
    } finally {
      reopenedLogger.close();
    }
  });
});

function logEntry(index: number, body = ""): RequestLogEntry {
  return {
    time: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    completed_at: new Date(Date.UTC(2026, 0, 1, 0, 1, index)).toISOString(),
    route: "compact",
    method: "POST",
    path: "/v1/responses/compact",
    endpoint: "/responses/compact",
    request_type: "http",
    reasoning_effort: null,
    request_summary: null,
    incoming_request_body: body.length > 0 ? body : null,
    upstream_request_body: body.length > 0 ? body : null,
    upstream_response_body: body.length > 0 ? body : null,
    client_response_body: null,
    body_status: body.length > 0 ? "present" : "none",
    compact_response_normalized: false,
    compact_response_normalize_reason: null,
    compact_response_synthetic_source: null,
    source_model: `gpt-5.${index}`,
    target_model: `gpt-5.${index}-compact`,
    response_model: null,
    status: 200,
    duration_ms: index,
    first_token_ms: null,
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    cached_output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    reasoning_tokens: null,
    additive_cached_input_tokens: false,
    additive_cached_output_tokens: false,
    total_tokens: null,
    upstream_host: "compact.example",
    user_agent: null,
    request_id: `request-${index}`,
    error_summary: null,
    capture_path: null,
    capture_status: "none"
  };
}

describe("getByRequestId", () => {
  it("returns not_found when request_id does not exist", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(10, databasePath);

    try {
      logger.add(logEntry(1));
      expect(logger.getByRequestId("nonexistent")).toEqual({ status: "not_found" });
    } finally {
      logger.close();
    }
  });

  it("returns the entry when exactly one exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(10, databasePath);

    try {
      const entry = logEntry(1);
      logger.add(entry);
      const result = logger.getByRequestId(entry.request_id);
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.entry.request_id).toBe(entry.request_id);
        expect(result.entry.source_model).toBe(entry.source_model);
      }
    } finally {
      logger.close();
    }
  });

  it("preserves duplicate legacy request IDs and reports them as multiple", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
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
          request_id TEXT NOT NULL
        );
      `);
      const insert = db.prepare(`
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
          request_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let index = 0; index < 2; index += 1) {
        insert.run(
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          "primary",
          "POST",
          "/v1/responses",
          "gpt-test",
          "gpt-test",
          200,
          1,
          "legacy.example",
          "duplicate-request-id"
        );
      }
    } finally {
      db.close();
    }

    const logger = new RequestLogger(10, databasePath);
    try {
      expect(logger.page({ limit: 10, offset: 0 }).all_total).toBe(2);
      expect(logger.getByRequestId("duplicate-request-id")).toEqual({ status: "multiple" });
    } finally {
      logger.close();
    }
  });

  it("uses a non-unique request ID index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(10, databasePath);
    logger.close();

    const db = new DatabaseSync(databasePath);
    try {
      const indexes = db.prepare("PRAGMA index_list(request_logs)").all() as Array<{
        name: string;
        partial: number;
        unique: number;
      }>;
      expect(indexes.find((index) => index.name === "idx_request_logs_request_id")).toMatchObject({
        unique: 0
      });
      expect(indexes.find((index) => index.name === "idx_request_logs_capture_path")).toMatchObject({
        unique: 0,
        partial: 1
      });
    } finally {
      db.close();
    }
  });
});

describe("runtime configuration", () => {
  it("applies a lower database byte cap immediately", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(10, databasePath, {
      maxDatabaseBytes: 10 * 1024 * 1024
    });

    try {
      for (let index = 1; index <= 6; index += 1) {
        logger.add(logEntry(index, "x".repeat(16 * 1024)));
      }
      expect(logger.page({ limit: 10, offset: 0 }).all_total).toBe(6);

      const configurableLogger = logger as unknown as {
        configure(options: { keepRecent: number; maxDatabaseBytes: number }): void;
      };
      configurableLogger.configure({
        keepRecent: 10,
        maxDatabaseBytes: 120 * 1024
      });

      const page = logger.page({ limit: 10, offset: 0 });
      expect(page.all_total).toBe(6);
      expect(page.logs.every((entry) => entry.body_status === "purged")).toBe(true);
      expect(databaseFootprintBytes(databasePath)).toBeLessThanOrEqual(120 * 1024);
    } finally {
      logger.close();
    }
  });
});

describe("markCapturePurged", () => {
  it("updates capture_status to purged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(10, databasePath);

    try {
      const entry = {
        ...logEntry(1),
        capture_path: "/path/to/capture.json",
        capture_status: "present" as const
      };
      logger.add(entry);
      logger.markCapturePurged("/path/to/capture.json");
      const result = logger.getByRequestId(entry.request_id);
      if (result.status === "found") {
        expect(result.entry.capture_path).toBeNull();
        expect(result.entry.capture_status).toBe("purged");
      } else {
        throw new Error("Expected found status");
      }
      expect(logger.getCaptureByRequestId(entry.request_id)).toMatchObject({
        status: "found",
        capturePath: null,
        captureStatus: "purged"
      });
    } finally {
      logger.close();
    }
  });
});

describe("capture recovery", () => {
  it("clears pending capture states when reopening the database", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-logger-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "compactgate-logs.sqlite");
    const logger = new RequestLogger(10, databasePath);
    logger.add({ ...logEntry(1), capture_status: "pending" });
    logger.close();

    const reopenedLogger = new RequestLogger(10, databasePath);
    try {
      const result = reopenedLogger.getByRequestId("request-1");
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.entry.capture_path).toBeNull();
        expect(result.entry.capture_status).toBe("none");
      }
    } finally {
      reopenedLogger.close();
    }
  });
});

function databaseFootprintBytes(databasePath: string): number {
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`
  ].reduce((total, filePath) => {
    return total + (existsSync(filePath) ? statSync(filePath).size : 0);
  }, 0);
}
