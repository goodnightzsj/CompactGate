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
  it("defaults the persisted SQLite database cap to 20 GiB", () => {
    expect(DEFAULT_MAX_LOG_DATABASE_BYTES).toBe(20 * 1024 * 1024 * 1024);
  });

  it("does not cap persisted SQLite logs by default", async () => {
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
        compactResponseSyntheticSource: null
      });

      expect(entry.time).toBe(startedAtIso);
      expect(entry.completed_at).toBe(completedAtIso);
      expect(logger.recent()[0].time).toBe(startedAtIso);
      expect(logger.recent()[0].completed_at).toBe(completedAtIso);
    } finally {
      logger.close();
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

  it("prunes oldest persisted logs when the database exceeds the byte cap", async () => {
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
      expect(page.all_total).toBeLessThan(6);
      expect(page.logs[0].source_model).toBe("gpt-5.6");
      expect(page.logs.some((entry) => entry.source_model === "gpt-5.1")).toBe(false);
      expect(databaseFootprintBytes(databasePath)).toBeLessThanOrEqual(maxDatabaseBytes);
    } finally {
      logger.close();
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
    compact_response_normalized: false,
    compact_response_normalize_reason: null,
    compact_response_synthetic_source: null,
    source_model: `gpt-5.${index}`,
    target_model: `gpt-5.${index}-compact`,
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
    error_summary: null
  };
}

function databaseFootprintBytes(databasePath: string): number {
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`
  ].reduce((total, filePath) => {
    return total + (existsSync(filePath) ? statSync(filePath).size : 0);
  }, 0);
}
