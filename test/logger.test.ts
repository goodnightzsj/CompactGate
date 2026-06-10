import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RequestLogger } from "../src/server/logger.js";
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

function logEntry(index: number): RequestLogEntry {
  return {
    time: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    route: "compact",
    method: "POST",
    path: "/v1/responses/compact",
    endpoint: "/responses/compact",
    request_type: "http",
    reasoning_effort: null,
    request_summary: null,
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
