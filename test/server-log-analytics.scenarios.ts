import { describe, expect, it } from "vitest";
import type { LogStatsSnapshot } from "../src/shared/types.js";
import {
  startApp,
  startUpstream
} from "./helpers/server-test-utils.js";

describe("log stats API", () => {
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
