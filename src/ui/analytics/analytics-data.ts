import { useEffect, useState } from "react";
import type { LogStatsMetric, LogStatsSnapshot } from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";

export type AnalyticsGranularity = "hour" | "day";
export type AnalyticsRange = LogStatsSnapshot["range"];
export type AnalyticsPreset = "24h" | "7d" | "30d";

export interface AnalyticsTrendPoint {
  key: string;
  label: string;
  requests: number;
  normal_requests: number;
  error_requests: number;
  usage_observed_requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

export function useLogStats(range: AnalyticsRange) {
  const [data, setData] = useState<LogStatsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ from: range.from, to: range.to });
    setData(null);
    setError(null);
    setLoading(true);
    void api<LogStatsSnapshot>(`/api/logs/stats?${query.toString()}`, {
      signal: controller.signal
    }).then((snapshot) => {
      setData(snapshot);
    }).catch((cause: unknown) => {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(errorSummary(cause));
      }
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    });

    return () => controller.abort();
  }, [range.from, range.to, revision]);

  return {
    data,
    error,
    loading,
    refresh: () => setRevision((current) => current + 1)
  };
}

export function rangeForPreset(preset: AnalyticsPreset, now = Date.now()): AnalyticsRange {
  if (preset === "24h") {
    return {
      from: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(now).toISOString()
    };
  }

  const end = new Date(now);
  const from = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  from.setDate(from.getDate() - (preset === "7d" ? 6 : 29));
  return {
    from: from.toISOString(),
    to: end.toISOString()
  };
}

export function defaultUsageDates(now = new Date()): { from: string; to: string } {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(to);
  from.setDate(from.getDate() - 6);
  return { from: inputDate(from), to: inputDate(to) };
}

export function dateInputsToRange(fromValue: string, toValue: string): AnalyticsRange {
  const from = parseInputDate(fromValue);
  const lastDay = parseInputDate(toValue);
  if (from.getTime() > lastDay.getTime()) {
    throw new Error("开始日期不能晚于结束日期。");
  }

  const calendarDays = Math.round((Date.UTC(
    lastDay.getFullYear(),
    lastDay.getMonth(),
    lastDay.getDate()
  ) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86_400_000) + 1;
  if (calendarDays > 31) {
    throw new Error("日期范围最多为 31 天。");
  }

  const to = new Date(lastDay);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function groupTrend(
  snapshot: LogStatsSnapshot,
  granularity: AnalyticsGranularity
): AnalyticsTrendPoint[] {
  const grouped = new Map<string, AnalyticsTrendPoint>();
  for (const point of snapshot.trend) {
    const date = new Date(point.bucket_start);
    const key = granularity === "hour" ? point.bucket_start : localDateKey(date);
    const current = grouped.get(key) ?? emptyTrendPoint(key, date, granularity);
    addMetric(current, point);
    grouped.set(key, current);
  }

  return granularity === "hour"
    ? filledHours(snapshot.range, grouped)
    : filledDays(snapshot.range, grouped);
}

export function usageCsv(points: AnalyticsTrendPoint[]): string {
  const header = [
    "period",
    "requests",
    "normal_requests",
    "error_requests",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "reasoning_tokens",
    "total_tokens"
  ];
  const rows = points.map((point) => [
    point.key,
    point.requests,
    point.normal_requests,
    point.error_requests,
    point.input_tokens,
    point.output_tokens,
    point.cache_read_tokens,
    point.cache_creation_tokens,
    point.reasoning_tokens,
    point.total_tokens
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.join(",")).join("\n")}\n`;
}

export function downloadUsageCsv(points: AnalyticsTrendPoint[]): void {
  const blob = new Blob([usageCsv(points)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `compactgate-usage-${inputDate(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function filledHours(
  range: AnalyticsRange,
  grouped: Map<string, AnalyticsTrendPoint>
): AnalyticsTrendPoint[] {
  const cursor = new Date(range.from);
  cursor.setUTCMinutes(0, 0, 0);
  const end = Date.parse(range.to);
  const result: AnalyticsTrendPoint[] = [];
  while (cursor.getTime() < end) {
    const key = cursor.toISOString();
    result.push(grouped.get(key) ?? emptyTrendPoint(key, cursor, "hour"));
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return result;
}

function filledDays(
  range: AnalyticsRange,
  grouped: Map<string, AnalyticsTrendPoint>
): AnalyticsTrendPoint[] {
  const start = new Date(range.from);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const end = Date.parse(range.to);
  const result: AnalyticsTrendPoint[] = [];
  while (cursor.getTime() < end) {
    const key = localDateKey(cursor);
    result.push(grouped.get(key) ?? emptyTrendPoint(key, cursor, "day"));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function emptyTrendPoint(
  key: string,
  date: Date,
  granularity: AnalyticsGranularity
): AnalyticsTrendPoint {
  return {
    key,
    label: new Intl.DateTimeFormat("zh-CN", granularity === "hour"
      ? { month: "2-digit", day: "2-digit", hour: "2-digit" }
      : { month: "2-digit", day: "2-digit" }).format(date),
    requests: 0,
    normal_requests: 0,
    error_requests: 0,
    usage_observed_requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0
  };
}

function addMetric(target: AnalyticsTrendPoint, metric: LogStatsMetric): void {
  target.requests += metric.requests;
  target.normal_requests += metric.normal_requests;
  target.error_requests += metric.error_requests;
  target.usage_observed_requests += metric.usage_observed_requests;
  target.input_tokens += metric.input_tokens;
  target.output_tokens += metric.output_tokens;
  target.cache_read_tokens += metric.cache_read_tokens;
  target.cache_creation_tokens += metric.cache_creation_tokens;
  target.reasoning_tokens += metric.reasoning_tokens;
  target.total_tokens += metric.total_tokens;
}

export function parseInputDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("请选择有效日期。");
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (inputDate(date) !== value) {
    throw new Error("请选择有效日期。");
  }
  return date;
}

export function inputDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateKey(date: Date): string {
  return inputDate(date);
}
