import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { LogStatsSnapshot } from "../src/shared/types.js";
import { RequestLogger } from "../src/server/logger.js";
import { LogStatsBusyError } from "../src/server/log-stats-reader.js";
import {
  startApp,
  startUpstream
} from "./helpers/server-test-utils.js";

describe("log stats API", () => {
  it("validates calendar dates without rejecting leap years or timezone offsets", async () => {
    const app = await startApp();
    for (const endpoint of ["stats", "recent"]) {
      for (const from of ["2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "1900-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z", "2026-11-20T24:00:00Z", "2026-11-20T00:00:00+24:00"]) {
        const response = await fetch(`${app.url}/api/logs/${endpoint}?${new URLSearchParams({ from,
          to: Number.isFinite(Date.parse(from)) ? new Date(Date.parse(from) + 3600000).toISOString() : "2026-11-21T00:00:00Z" })}`);
        expect(response.status, `${endpoint}: ${from}`).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("RFC 3339") });
      }
      for (const from of ["2024-02-29T23:59:59.123Z", "2000-02-29T00:00:00+08:00",
        "0096-02-29T00:00:00-04:30", "2026-04-30T23:59:59+05:45"]) {
        const response = await fetch(`${app.url}/api/logs/${endpoint}?${new URLSearchParams({ from,
          to: new Date(Date.parse(from) + 3600000).toISOString() })}`);
        expect(response.status, `${endpoint}: ${from}`).toBe(200);
        const result = await response.json();
        if (endpoint === "stats") expect(result.range.from).toBe(new Date(Date.parse(from)).toISOString());
        else expect(result.logs).toEqual([]);
      }
    }
  });

  it("applies the selected timezone's calendar dates to statistics and log drilldowns", async () => {
    const app = await startApp();
    const from = "2026-10-15T04:00:00.000Z";
    const to = "2026-11-15T05:00:00.000Z"; // New York's 31 dates include the fall-back hour.
    const db = new DatabaseSync(path.join(app.dir, "compactgate-logs.sqlite"));
    try {
      const insert = db.prepare(`INSERT INTO request_logs (time, route, method, path, status, duration_ms, upstream_host, request_id, response_model)
        VALUES (?, 'primary', 'POST', '/v1/responses', 200, 1, 'synthetic.invalid', ?, 'selected')`);
      for (const time of [Date.parse(from) - 1, Date.parse(from), Date.parse(to) - 1, Date.parse(to)]) {
        insert.run(new Date(time).toISOString(), String(time));
      }
    } finally { db.close(); }
    for (const path of ["/api/logs/stats?view=usage", "/api/logs/recent?model=selected"]) {
      async function request(fields: Record<string, string>) {
        return fetch(`${app.url}${path}&${new URLSearchParams(fields)}`);
      }
      const response = await request({ from, to, calendar_tz: "America/New_York" });
      expect(response.status).toBe(200);
      const result = await response.json();
      if (path.includes("stats")) {
        expect(result.range).toEqual({ from, to, calendar_tz: "America/New_York" });
        expect(result.summary.requests).toBe(2);
      } else {
        expect(result.logs.map((row: { time: string }) => row.time)).toEqual([new Date(Date.parse(to) - 1).toISOString(), from]);
      }
      const invalidRanges: Record<string, string>[] = [
        { from, to }, { from, to, calendar_tz: "UTC" }, { from, to, calendar_tz: "invalid/zone" }, { from, to, calendar_tz: "-04:00" },
        { from, to: "2026-11-15T05:00:00.001Z", calendar_tz: "America/New_York" },
        // Spans 32 named dates despite containing less than 31 x 24 hours.
        { from: "2026-02-15T04:59:00Z", to: "2026-03-17T04:01:00Z", calendar_tz: "America/New_York" }
      ];
      for (const fields of invalidRanges) {
        const invalid = await request(fields);
        expect(invalid.status).toBe(400);
        await invalid.arrayBuffer();
      }
      const halfHour = await request({ from: "2026-03-15T13:00:00Z", to: "2026-04-15T13:30:00Z", calendar_tz: "Australia/Lord_Howe" });
      expect(halfHour.status).toBe(200);
      await halfHour.arrayBuffer();
    }
  });

  it("preserves full statistics range fields and ignores statistics-only options on recent logs", async () => {
    const app = await startApp();
    const range = { from: "2026-08-07T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" };
    for (const overview of ["0", "1"]) {
      const response = await fetch(`${app.url}/api/logs/stats?${new URLSearchParams({ ...range, overview })}`);
      expect(response.status).toBe(200);
      expect((await response.json()).range).toEqual({ ...range, includeOverview: overview === "1" });
    }
    const recentOptions: Record<string, string>[] = [{ view: "full" }, { view: "usage", overview: "1" }];
    for (const query of recentOptions) {
      const response = await fetch(`${app.url}/api/logs/recent?${new URLSearchParams({ ...range, ...query })}`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ total: 0, logs: [] });
    }
  });
  it("reports queue saturation separately from query failures", async () => {
    const app = await startApp();
    const stats = vi.spyOn(RequestLogger.prototype, "statsAsync");
    try {
      stats.mockRejectedValueOnce(new LogStatsBusyError());
      const busy = await fetch(`${app.url}/api/logs/stats`);
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("1");
      await expect(busy.json()).resolves.toMatchObject({ error: expect.stringContaining("busy") });
      stats.mockRejectedValueOnce(new Error("synthetic SQL failure"));
      const failed = await fetch(`${app.url}/api/logs/stats`);
      expect(failed.status).toBe(500);
      await expect(failed.json()).resolves.toEqual({ error: "synthetic SQL failure" });
    } finally {
      stats.mockRestore();
    }
  });

  it("cancels abandoned statistics requests while other API routes remain usable", async () => {
    const app = await startApp();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let cancelled!: () => void;
    const stopped = new Promise<void>((resolve) => { cancelled = resolve; });
    const stats = vi.spyOn(RequestLogger.prototype, "statsAsync").mockImplementation((_options, signal) => {
      entered();
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => {
          cancelled();
          reject(signal!.reason);
        }, { once: true });
      });
    });
    const controller = new AbortController();
    const pending = fetch(`${app.url}/api/logs/stats`, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      await started;
      const health = await fetch(`${app.url}/api/health`);
      expect(health.status).toBe(200);
      await health.arrayBuffer();
      controller.abort();
      await Promise.all([rejected, stopped]);
    } finally {
      controller.abort();
      stats.mockRestore();
    }
  });

  it("returns an empty default snapshot and rejects invalid ranges", async () => {
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await fetch(`${app.url}/api/logs/stats?overview=1`);
    expect(response.status).toBe(200);
    const stats = await response.json() as LogStatsSnapshot;
    expect(stats.summary.requests).toBe(0);
    expect(stats.trend).toEqual([]);
    expect(stats.by_host).toEqual([]);
    expect(stats.overview?.today.summary.requests).toBe(0);
    expect(stats.overview?.retained.summary.requests).toBe(0);
    expect(stats.overview?.recent.one_minute.requests).toBe(0);
    expect(stats.overview?.recent.five_minutes.average_rpm).toBe(0);
    expect(stats.range.from < stats.range.to).toBe(true);

    const usage = await fetch(`${app.url}/api/logs/stats?view=usage`);
    expect(usage.status).toBe(200);
    const usageStats = await usage.json();
    expect(usageStats).toMatchObject({ view: "usage", summary: { requests: 0 }, overview: null });
    expect(usageStats).not.toHaveProperty("by_host");
    expect(usageStats.summary).not.toHaveProperty("duration_p95_ms");
    for (const suffix of ["view=unknown", "view=usage&overview=1"]) {
      const invalidView = await fetch(`${app.url}/api/logs/stats?${suffix}`);
      expect(invalidView.status).toBe(400);
      await invalidView.arrayBuffer();
    }

    const invalid = await fetch(`${app.url}/api/logs/stats?from=not-a-date`);
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: "logs stats from must be an RFC 3339 timestamp."
    });

    const dateOnly = await fetch(`${app.url}/api/logs/stats?from=2026-08-07`);
    expect(dateOnly.status).toBe(400);

    const reversed = await fetch(
      `${app.url}/api/logs/stats?from=2026-08-08T00:00:00.000Z&to=2026-08-07T00:00:00.000Z`
    );
    expect(reversed.status).toBe(400);

    const tooLong = await fetch(
      `${app.url}/api/logs/stats?from=2026-06-01T00:00:00.000Z&to=2026-08-07T00:00:00.000Z`
    );
    expect(tooLong.status).toBe(400);

    const range = { from: "2026-09-29T00:00:00+08:00", to: "2026-09-30T00:00:00+08:00" };
    const invalidDrilldowns: Record<string, string>[] = [
      { model: "exact" }, { from: range.from }, { ...range, from: "bad" },
      { ...range, to: range.from }, { ...range, from: "2026-01-01T00:00:00Z" },
      { ...range, model: "x".repeat(8193) }
    ];
    for (const query of invalidDrilldowns) {
      const result = await fetch(`${app.url}/api/logs/recent?${new URLSearchParams(query)}`);
      expect(result.status).toBe(400);
    }
    for (const model of ["", "exact + %_"]) {
      const result = await fetch(`${app.url}/api/logs/recent?${new URLSearchParams({ ...range, model })}`);
      expect(result.status).toBe(200);
      await expect(result.json()).resolves.toMatchObject({ total: 0, logs: [] });
    }
  });
});
