import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestLogger } from "../src/server/logger.js";
import { readLogPage } from "../src/server/logger-page.js";
import { startApp } from "./helpers/server-test-utils.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const clean of cleanup.splice(0).reverse()) await clean();
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-log-page-reader-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, "logs.sqlite");
  const logger = new RequestLogger(10, databasePath, { maxDatabaseBytes: 0 });
  cleanup.push(() => logger.close());
  const writer = new DatabaseSync(databasePath);
  cleanup.push(() => writer.close());
  writer.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 100)
    INSERT INTO request_logs(time, route, method, path, status, duration_ms, upstream_host, request_id)
    SELECT '2026-11-18T00:00:00.000Z', CASE WHEN n % 10 = 0 THEN 'compact' ELSE 'primary' END,
      'POST', '/v1/responses', CASE WHEN n % 2 = 0 THEN 500 ELSE 200 END, 1, 'fixture.invalid', CAST(n AS TEXT) FROM rows`);
  return { logger, writer, databasePath };
}

describe("log page reader", () => {
  it("shares search work without changing cross-filter exclusions, literal search or legacy routes", async () => {
    const { writer } = await fixture();
    writer.prepare(`INSERT INTO request_logs(time, route, method, path, status, duration_ms, upstream_host, request_id, request_summary)
      VALUES ('2026-11-18T00:00:00.000Z', ?, 'POST', '/v1/responses', 200, 1, 'B.invalid', ?, ?)`)
      .run("legacy-route", "legacy", "literal %_\\ text");
    writer.prepare(`INSERT INTO request_logs(time, route, method, path, status, duration_ms, upstream_host, request_id)
      VALUES ('2026-11-18T00:00:00.000Z', 'primary', 'POST', '/v1/responses', 200, 1, 'B.invalid', 'other')`).run();
    const page = readLogPage(writer, { limit: 5, offset: 0, search: "responses", route: "primary", status: "normal", host: "fixture.invalid" });
    expect(page).toMatchObject({ total: 50, all_total: 102,
      counts: { all: 50, primary: 50, compact: 0, claude: 0 },
      status_counts: { all: 90, normal: 50, error: 40 },
      host_counts: [{ host: "fixture.invalid", total: 50, primary: 50 }, { host: "B.invalid", total: 1, primary: 1 }] });
    const literal = readLogPage(writer, { limit: 5, offset: 0, search: "%_\\" });
    expect(literal.logs.map(log => log.request_id)).toEqual(["legacy"]);
    expect(literal).toMatchObject({ total: 1, counts: { all: 1, primary: 1 }, host_counts: [{ host: "B.invalid", total: 1, primary: 0 }] });
    const drilldown = readLogPage(writer, { limit: 5, offset: 0, search: "responses", route: "primary", drilldown: {
      from: "2026-11-18T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z", model: null
    } });
    expect(drilldown.total).toBe(91);
  });
  it.each(["search=fixture", "host=fixture.invalid", "status=error", "status=normal"])("serves %s without scanning logs on the HTTP thread", async query => {
    const app = await startApp();
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql) {
      if (sql.includes("FROM request_logs")) throw new Error("Log scan executed on the main thread");
      return prepare.call(this, sql);
    });
    const response = await fetch(`${app.url}/api/logs/recent?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ logs: [], total: 0, all_total: 0 });
  });

  it.each([
    { host: "fixture.invalid" }, { status: "error" as const }, { status: "normal" as const },
    { host: "fixture.invalid", status: "error" as const, route: "compact" as const }
  ])("preserves the complete page contract for %j", async filters => {
    const { logger, writer } = await fixture();
    const options = { ...filters, limit: 3, offset: 2 };
    expect(await logger.pageAsync(options)).toEqual(logger.page(options));
    writer.exec("DELETE FROM request_logs WHERE id > 50");
    expect(await logger.pageAsync(options)).toEqual(logger.page(options));
  });

  it("retains paging, facet exclusions and committed updates", async () => {
    const { logger, writer } = await fixture();
    const page = await logger.pageAsync({ limit: 10, offset: 0, search: "fixture", route: "compact" });
    expect(page).toMatchObject({ total: 10, all_total: 100, has_more: false,
      counts: { all: 100, primary: 90, compact: 10, claude: 0 },
      status_counts: { all: 10, error: 10, normal: 0 },
      host_counts: [{ host: "fixture.invalid", total: 10, compact: 10 }] });
    expect(page.logs[0].request_id).toBe("100");
    writer.exec("DELETE FROM request_logs WHERE id > 50");
    const updated = await logger.pageAsync({ limit: 2, offset: 2, search: "fixture", route: "compact" });
    expect(updated).toMatchObject({ total: 5, all_total: 50, has_more: true });
    expect(updated.logs.map(row => row.request_id)).toEqual(["30", "20"]);
  });

  it("does not add a fixed pending-request rejection limit to searches", async () => {
    const { logger } = await fixture();
    const pages = await Promise.all(Array.from({ length: 20 }, () => logger.pageAsync({
      limit: 10, offset: 0, search: "fixture"
    })));
    expect(pages.every(page => page.total === 100)).toBe(true);
  });

  it.each([false, true])("waits for actual search reads before maintenance (active cancelled=%s)", async cancelledActive => {
    const { logger, writer } = await fixture();
    writer.exec("UPDATE request_logs SET incoming_request_body = 'fixture body', body_status = 'present'");
    const activeController = new AbortController();
    const active = logger.pageAsync({ limit: 10, offset: 0, search: "fixture" }, activeController.signal);
    const checked = cancelledActive ? expect(active).rejects.toMatchObject({ name: "AbortError" }) : active;
    const controller = new AbortController();
    const queued = logger.pageAsync({ limit: 10, offset: 0, search: "fixture" }, controller.signal);
    const cancelled = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    if (cancelledActive) activeController.abort();
    const purged = logger.purgeStoredBodies();
    expect(writer.prepare("SELECT incoming_request_body AS body FROM request_logs WHERE id = 1").get()?.body).toBe("fixture body");
    await checked;
    await cancelled;
    await expect(Promise.resolve(purged)).resolves.toMatchObject({ rows_cleared: 100, row_count_after: 100 });
  });

  it("holds one page snapshot across concurrent writes", async () => {
    const { databasePath, writer } = await fixture();
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    cleanup.push(() => reader.close());
    const prepare = reader.prepare.bind(reader);
    let changed = false;
    vi.spyOn(reader, "prepare").mockImplementation(sql => {
      if (sql.includes("SUM(count)") && !changed) {
        changed = true;
        writer.exec("DELETE FROM request_logs");
      }
      return prepare(sql);
    });
    const page = readLogPage(reader, { limit: 10, offset: 0, search: "fixture" });
    expect(changed).toBe(true);
    expect(page).toMatchObject({ total: 100, all_total: 100, latest_sequence: 100 });
    expect(page.logs).toHaveLength(10);
    expect(page.counts.all).toBe(100);
    expect(readLogPage(reader, { limit: 10, offset: 0, search: "fixture" }).total).toBe(0);
  });

  it("recovers from SQL failure and rejects pending pages on close", async () => {
    const { logger, writer } = await fixture();
    await logger.pageAsync({ limit: 10, offset: 0, search: "fixture" });
    writer.exec("ALTER TABLE request_logs RENAME TO unavailable_logs");
    await expect(logger.pageAsync({ limit: 10, offset: 0, search: "fixture" })).rejects.toThrow("no such table");
    writer.exec("ALTER TABLE unavailable_logs RENAME TO request_logs");
    expect((await logger.pageAsync({ limit: 10, offset: 0, search: "fixture" })).total).toBe(100);
    const pending = logger.pageAsync({ limit: 10, offset: 0, search: "fixture" });
    const rejected = expect(pending).rejects.toThrow("closed");
    await logger.close();
    await rejected;
    await expect(logger.pageAsync({ limit: 10, offset: 0 })).rejects.toThrow("closed");
  });
});
