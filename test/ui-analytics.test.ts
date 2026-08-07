import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  LogStatsMetric,
  LogStatsSnapshot,
  LogStatsSummary
} from "../src/shared/types.js";
import {
  dateInputsToRange,
  groupTrend,
  platformBreakdown,
  presetForRange,
  rangeForPreset,
  usageCsv
} from "../src/ui/analytics/analytics-data.js";
import {
  AnalyticsTokenBreakdownChart,
  cacheHitRate
} from "../src/ui/analytics/AnalyticsShared.js";
import { DateRangePicker } from "../src/ui/analytics/DateRangePicker.js";
import { formatCompactMetricNumber } from "../src/ui/shared/format.js";

describe("analytics data helpers", () => {
  it("formats analytics-scale values without changing precise formatters", () => {
    expect(formatCompactMetricNumber(999)).toBe("999");
    expect(formatCompactMetricNumber(1_900_000)).toBe("1.9M");
    expect(formatCompactMetricNumber(2_360_000_000)).toBe("2.4B");
  });

  it("uses the shared cache rate formula for overall and model metrics", () => {
    expect(cacheHitRate(100, 42)).toBe("42.0%");
    expect(cacheHitRate(100, 120)).toBe("100.0%");
    expect(cacheHitRate(0, 0)).toBe("-");
  });

  it("groups primary and compact traffic as GPT while keeping Claude separate", () => {
    const rows = [
      { route: "primary" as const, ...metric({ requests: 3, error_requests: 1, total_tokens: 30 }) },
      { route: "compact" as const, ...metric({ requests: 2, total_tokens: 20 }) },
      { route: "claude" as const, ...metric({ requests: 4, total_tokens: 40 }) }
    ];

    expect(platformBreakdown(rows)).toEqual([
      { label: "GPT", requests: 5, error_requests: 1, total_tokens: 50 },
      { label: "Claude", requests: 4, error_requests: 0, total_tokens: 40 }
    ]);
  });

  it("renders the custom range trigger without native date inputs", () => {
    const markup = renderToStaticMarkup(createElement(DateRangePicker, {
      from: "2026-08-01",
      to: "2026-08-07",
      onApply: () => undefined
    }));

    expect(markup).toContain("日期范围");
    expect(markup).toContain("aria-haspopup=\"dialog\"");
    expect(markup).not.toContain("type=\"date\"");
  });

  it("renders token components and cache rate with exact point details", () => {
    const stats = snapshot([
      {
        bucket_start: "2026-08-07T00:00:00.000Z",
        ...metric({
          input_tokens: 1_000,
          output_tokens: 50,
          cache_read_tokens: 500,
          cache_creation_tokens: 100,
          total_tokens: 1_150
        })
      }
    ]);
    const markup = renderToStaticMarkup(createElement(AnalyticsTokenBreakdownChart, {
      points: groupTrend(stats, "hour")
    }));

    expect(markup).toContain("缓存创建");
    expect(markup).toContain("缓存率");
    expect(markup).toContain("输入 1,000");
    expect(markup).toContain("缓存率 50.0%");
  });

  it("treats date inputs as inclusive local calendar days with a 31-day limit", () => {
    const range = dateInputsToRange("2026-08-01", "2026-08-31");
    const from = new Date(range.from);
    const to = new Date(range.to);

    expect([from.getFullYear(), from.getMonth(), from.getDate()]).toEqual([2026, 7, 1]);
    expect([to.getFullYear(), to.getMonth(), to.getDate()]).toEqual([2026, 8, 1]);
    expect(() => dateInputsToRange("2026-08-02", "2026-08-01")).toThrow(
      "开始日期不能晚于结束日期。"
    );
    expect(() => dateInputsToRange("2026-08-01", "2026-09-01")).toThrow(
      "日期范围最多为 31 天。"
    );
  });

  it("uses local calendar boundaries for multi-day dashboard presets", () => {
    const now = new Date(2026, 7, 7, 15, 30, 0);
    const range = rangeForPreset("7d", now.getTime());
    const from = new Date(range.from);

    expect([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours()]).toEqual([
      2026,
      7,
      1,
      0
    ]);
    expect(range.to).toBe(now.toISOString());
  });

  it("derives the displayed preset from the rendered snapshot range", () => {
    const now = new Date(2026, 7, 7, 15, 30, 0).getTime();

    expect(presetForRange(rangeForPreset("24h", now))).toBe("24h");
    expect(presetForRange(rangeForPreset("7d", now))).toBe("7d");
    expect(presetForRange(rangeForPreset("30d", now))).toBe("30d");
  });

  it("fills missing hours and exports the visible usage rows", () => {
    const stats = snapshot([
      { bucket_start: "2026-08-07T00:00:00.000Z", ...metric({ requests: 2, total_tokens: 20 }) },
      { bucket_start: "2026-08-07T02:00:00.000Z", ...metric({ requests: 1, total_tokens: 7 }) }
    ]);
    const points = groupTrend(stats, "hour");

    expect(points.map((point) => [point.key, point.requests, point.total_tokens])).toEqual([
      ["2026-08-07T00:00:00.000Z", 2, 20],
      ["2026-08-07T01:00:00.000Z", 0, 0],
      ["2026-08-07T02:00:00.000Z", 1, 7]
    ]);
    expect(usageCsv(points)).toContain("period,requests,normal_requests,error_requests");
    expect(usageCsv(points)).toContain("2026-08-07T01:00:00.000Z,0,0,0");
  });
});

function snapshot(trend: LogStatsSnapshot["trend"]): LogStatsSnapshot {
  const summary: LogStatsSummary = {
    ...metric(),
    duration_p50_ms: null,
    duration_p95_ms: null,
    first_token_p50_ms: null,
    first_token_p95_ms: null,
    average_rpm: 0,
    average_tpm: 0
  };
  return {
    generated_at: "2026-08-07T03:00:00.000Z",
    range: {
      from: "2026-08-07T00:00:00.000Z",
      to: "2026-08-07T03:00:00.000Z"
    },
    retained_range: { oldest_at: null, newest_at: null },
    summary,
    trend,
    by_route: [],
    by_host: [],
    by_model: [],
    by_endpoint: [],
    model_mappings: [],
    overview: null
  };
}

function metric(overrides: Partial<LogStatsMetric> = {}): LogStatsMetric {
  return {
    requests: 0,
    normal_requests: 0,
    error_requests: 0,
    usage_observed_requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    average_duration_ms: null,
    average_first_token_ms: null,
    ...overrides
  };
}
