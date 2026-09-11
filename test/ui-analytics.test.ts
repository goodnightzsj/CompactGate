import { afterEach, describe, expect, it, vi } from "vitest";
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
import * as analyticsData from "../src/ui/analytics/analytics-data.js";
import {
  AnalyticsRefreshStatus,
  AnalyticsTokenBreakdownChart,
  AnalyticsTrendChart,
  cacheHitRate
} from "../src/ui/analytics/AnalyticsShared.js";
import { AnalyticsDashboardPage } from "../src/ui/analytics/AnalyticsDashboardPage.js";
import { UsageAnalyticsPage } from "../src/ui/analytics/UsageAnalyticsPage.js";
import { DateRangePicker } from "../src/ui/analytics/DateRangePicker.js";
import { formatCompactMetricNumber } from "../src/ui/shared/format.js";

afterEach(() => vi.restoreAllMocks());

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
    expect(markup).toContain('type="range"');
    expect(markup).toContain('aria-label="Token 明细时段"');
  });

  it("exposes an exact, keyboard-operable request readout", () => {
    const stats = snapshot([{ bucket_start: "2026-08-07T02:00:00.000Z", ...metric({ requests: 12, error_requests: 2 }) }]);
    const markup = renderToStaticMarkup(createElement(AnalyticsTrendChart, { points: groupTrend(stats, "hour"), metric: "requests" }));
    expect(markup).toContain('aria-label="请求趋势时段"');
    expect(markup).toContain("12 请求，错误 2");
    expect(markup).toContain('max="2"');
  });

  it("keeps existing statistics visible and announces a refresh", () => {
    vi.spyOn(analyticsData, "useLogStats").mockReturnValue({ data: snapshot([]), loading: true, error: null, refresh: vi.fn() });
    const markup = renderToStaticMarkup(createElement(AnalyticsDashboardPage));
    expect(markup).toContain("正在更新，当前显示上次统计");
    expect(markup).toMatch(/analytics-refresh[^>]*disabled/);
    expect(markup).toContain('aria-busy="true"');
  });

  it("shows the actual sample time on both pages without implying live polling", () => {
    const stats = snapshot([]);
    vi.spyOn(analyticsData, "useLogStats").mockReturnValue({ data: stats, loading: false, error: null, refresh: vi.fn() });
    for (const Page of [AnalyticsDashboardPage, UsageAnalyticsPage]) {
      const markup = renderToStaticMarkup(createElement(Page));
      expect(markup).toContain("采样于");
      expect(markup).toContain(stats.generated_at);
      expect(markup).toContain("手动刷新");
    }
  });

  it("labels retained data as stale after a failed refresh", () => {
    const markup = renderToStaticMarkup(createElement(AnalyticsRefreshStatus, {
      loading: false,
      error: "synthetic failure",
      generatedAt: "2026-08-07T03:00:00.000Z"
    }));
    expect(markup).toContain("更新失败，保留上次统计");
    expect(markup).toContain("2026-08-07T03:00:00.000Z");
    expect(markup).not.toContain("统计已更新");
  });

  it("keeps all exact token components visible below the three usage metrics", () => {
    const stats = snapshot([]);
    stats.summary.total_tokens = 1_900_000;
    stats.summary.input_tokens = 1_800_000;
    vi.spyOn(analyticsData, "useLogStats").mockReturnValue({ data: stats, loading: false, error: null, refresh: vi.fn() });
    const markup = renderToStaticMarkup(createElement(UsageAnalyticsPage));
    const primary = markup.match(/<section class="usage-metric-grid"[^>]*>(.*?)<\/section>/)?.[1] ?? "";
    const details = markup.match(/<section class="analytics-metric-section usage-token-metrics"[^>]*>(.*?)<\/section>/)?.[1] ?? "";
    expect(primary.match(/<article /g)).toHaveLength(3);
    expect(primary).toContain('title="1,900,000"');
    expect(details.match(/<article /g)).toHaveLength(4);
    expect(details).toContain('title="1,800,000"');
    for (const label of ["总输入", "输出", "缓存读取", "缓存创建"]) expect(details).toContain(label);
    expect(details).toContain('<h3 id="usage-token-heading">Token 构成</h3>');
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("<summary");
  });

  it("renders rolling operational metrics independently from range averages", () => {
    const stats = snapshot([]);
    stats.summary.average_rpm = 99;
    stats.summary.average_tpm = 999_999;
    stats.overview = {
      recent: {
        one_minute: metric({ requests: 3, total_tokens: 21_200 }),
        five_minutes: {
          ...metric({
            input_tokens: 100,
            cache_read_tokens: 50,
            total_tokens: 92_000,
            average_duration_ms: 220,
            average_first_token_ms: 40
          }),
          duration_p50_ms: 200,
          duration_p95_ms: 500,
          first_token_p50_ms: 30,
          first_token_p95_ms: 80,
          average_rpm: 2.4,
          average_tpm: 18_400
        }
      },
      today: {
        from: "2026-08-07T00:00:00.000Z",
        to: stats.generated_at,
        summary: metric()
      },
      retained: { summary: metric() }
    };
    vi.spyOn(analyticsData, "useLogStats").mockReturnValue({
      data: stats,
      error: null,
      loading: false,
      refresh: vi.fn()
    });

    const markup = renderToStaticMarkup(createElement(AnalyticsDashboardPage));

    expect(markup).toContain("aria-label=\"历史统计范围\"");
    expect(markup).toContain("近 5 分钟 RPM");
    expect(markup).toContain("2.40 RPM");
    expect(markup).toContain("近 5 分钟 18.4K TPM");
    expect(markup).toContain("近 1 分钟 3.00 RPM");
    expect(markup).toContain("21.2K TPM");
    expect(markup).toContain("近 5 分钟缓存命中");
    expect(markup).toContain("50.0%");
    expect(markup).toContain("近 5 分钟首 Token P50 / P95");
    expect(markup).toContain("近 5 分钟总耗时 P50 / P95");
    expect(markup).not.toContain("99.00 RPM");
    const latency = markup.match(/<section class="analytics-metric-section analytics-latency-metrics"[^>]*>(.*?)<\/section>/)?.[1] ?? "";
    expect(latency.match(/<article /g)).toHaveLength(2);
    expect(latency).toContain("30ms / 80ms");
    expect(latency).toContain("200ms / 500ms");
    expect(latency).toContain("平均 40ms");
    expect(latency).toContain('<h3 id="analytics-latency-heading">响应耗时</h3>');
    expect(markup.slice(0, markup.indexOf('<section class="analytics-metric-section analytics-latency-metrics"')).match(/<article /g)).toHaveLength(4);
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("<summary");
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
