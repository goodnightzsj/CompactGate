import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLogStats } from "../src/server/logger-analytics.js";
import { RequestLogger } from "../src/server/logger.js";
import { LogStatsBusyError, LogStatsReader } from "../src/server/log-stats-reader.js";

const range = { from: "2026-08-07T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" };
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(rows = 1) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-stats-worker-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, "logs.sqlite");
  const logger = new RequestLogger(10, databasePath, { maxDatabaseBytes: 0 });
  cleanups.push(() => logger.close());
  const writer = new DatabaseSync(databasePath);
  cleanups.push(() => writer.close());
  writer.exec(`
    WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ${rows})
    INSERT INTO request_logs(time, route, method, path, status, duration_ms, upstream_host, request_id, input_tokens, total_tokens)
    SELECT '2026-08-07T00:00:00.000Z', CASE WHEN n % 10 = 0 THEN 'compact' ELSE 'primary' END,
      'POST', '/v1/responses', 200, n, 'fixture.invalid', CAST(n AS TEXT), 10, 10 FROM rows
  `);
  return { logger, writer, databasePath };
}

describe("log statistics reader", () => {
  it("runs stats away from the event loop and reuses current committed data after writes and deletes", async () => {
    const { logger, writer } = await fixture(10_000);
    await logger.statsAsync({ ...range, view: "usage" });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const full = await logger.statsAsync({ ...range, includeOverview: true });
      expect(full.summary.requests).toBe(10_000);
      expect(full.overview?.retained.summary.total_tokens).toBe(100_000);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
    writer.exec("UPDATE request_logs SET input_tokens = 20, total_tokens = 20 WHERE id = 1; DELETE FROM request_logs WHERE id > 5");
    const updated = await logger.statsAsync({ ...range, includeOverview: true });
    expect(updated.summary).toMatchObject({ requests: 5, input_tokens: 60, total_tokens: 60 });
    expect(updated.overview?.retained.summary).toEqual(expect.objectContaining({ requests: 5, total_tokens: 60 }));
    expect(updated.trend.reduce((sum, row) => sum + row.requests, 0)).toBe(5);
    expect(updated.by_route.reduce((sum, row) => sum + row.requests, 0)).toBe(5);
  });

  it("bounds pending work, removes queued cancellations and ignores a cancelled active result", async () => {
    const { logger } = await fixture();
    const activeController = new AbortController();
    const first = logger.statsAsync(range, activeController.signal);
    const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const queuedController = new AbortController();
    const queued = logger.statsAsync(range, queuedController.signal);
    const queuedRejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    const rest = Array.from({ length: 6 }, () => logger.statsAsync(range));
    await expect(logger.statsAsync(range)).rejects.toBeInstanceOf(LogStatsBusyError);
    queuedController.abort();
    activeController.abort();
    const replacement = logger.statsAsync({ ...range, view: "usage" });
    await Promise.all([firstRejected, queuedRejected]);
    for (const stats of await Promise.all(rest)) expect(stats.summary.requests).toBe(1);
    expect((await replacement).summary.requests).toBe(1);
    await expect(logger.statsAsync(range, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects pending work and waits for the worker on close", async () => {
    const { logger } = await fixture();
    const pending = [logger.statsAsync(range), logger.statsAsync(range)];
    const rejected = Promise.all(pending.map((query) => expect(query).rejects.toThrow("closed")));
    await logger.close();
    await rejected;
    await expect(logger.statsAsync(range)).rejects.toThrow("closed");
    await logger.close();
  });

  it("reports SQL failures and recovers the read transaction for the next request", async () => {
    const { databasePath, writer } = await fixture();
    const reader = new LogStatsReader(databasePath);
    cleanups.push(() => reader.close());
    await reader.read(range);
    writer.exec("ALTER TABLE request_logs RENAME TO temporarily_unavailable_logs");
    await expect(reader.read(range)).rejects.toThrow("no such table");
    writer.exec("ALTER TABLE temporarily_unavailable_logs RENAME TO request_logs");
    expect((await reader.read(range)).summary.requests).toBe(1);
  });

  it("reports worker startup failure instead of falling back to the main thread", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-stats-missing-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const reader = new LogStatsReader(path.join(dir, "missing.sqlite"));
    cleanups.push(() => reader.close());
    await expect(reader.read(range)).rejects.toThrow(/unable to open database/i);
  });

  it("fails the bounded queue when its execution deadline expires", async () => {
    const { logger } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests = [logger.statsAsync(range), logger.statsAsync(range)];
    const rejected = Promise.all(requests.map((query) => expect(query).rejects.toThrow("deadline")));
    vi.advanceTimersByTime(60_000);
    await rejected;
    vi.useRealTimers();
    await logger.close();
  });

  it("holds one snapshot while a separate connection changes the database", async () => {
    const { databasePath, writer } = await fixture();
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    cleanups.push(() => reader.close());
    const prepare = reader.prepare.bind(reader);
    let changed = false;
    vi.spyOn(reader, "prepare").mockImplementation((sql) => {
      if (sql.includes("analytics_rows") && !changed) {
        changed = true;
        writer.exec("DELETE FROM request_logs");
      }
      return prepare(sql);
    });
    const snapshot = readLogStats(reader, { ...range, includeOverview: true });
    expect(changed).toBe(true);
    expect(snapshot.summary.requests).toBe(1);
    expect(snapshot.trend[0].requests).toBe(1);
    expect(snapshot.overview?.retained.summary.requests).toBe(1);
    expect(snapshot.retained_range.oldest_at).toBe(range.from);
    await nextTurn();
    expect(readLogStats(reader, range).summary.requests).toBe(0);
  });

  it("uses the route index for recent compact logs and index searches for retained bounds", async () => {
    const { writer } = await fixture(100);
    const recent = writer.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM request_logs WHERE route = ? ORDER BY id DESC LIMIT 200"
    ).all("compact");
    expect(recent.map((row) => row.detail).join("\n")).toContain("idx_request_logs_route_id");
    const bounds = writer.prepare(`EXPLAIN QUERY PLAN SELECT
      (SELECT MIN(time) FROM request_logs), (SELECT MAX(time) FROM request_logs)`
    ).all().map((row) => String(row.detail));
    expect(bounds.filter((detail) => detail.includes("SEARCH request_logs USING COVERING INDEX idx_request_logs_time"))).toHaveLength(2);
    expect(bounds.some((detail) => detail.includes("SCAN request_logs"))).toBe(false);
  });
});
