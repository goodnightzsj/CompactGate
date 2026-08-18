import { useMemo, useState } from "react";
import {
  formatCompactMetricNumber,
  formatDurationMs,
  formatMetricNumber
} from "../shared/format.js";
import {
  AnalyticsDistribution,
  AnalyticsLoadState,
  AnalyticsMetricGrid,
  AnalyticsPanel,
  AnalyticsSegmented,
  AnalyticsTrendChart,
  cacheHitRate,
  durationPair,
  RetainedRange
} from "./AnalyticsShared.js";
import {
  groupTrend,
  platformBreakdown,
  presetForRange,
  rangeForPreset,
  type AnalyticsPreset,
  useLogStats
} from "./analytics-data.js";

const PRESETS: Array<{ value: AnalyticsPreset; label: string }> = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" }
];

const SOURCE_OPTIONS = [
  { value: "platform", label: "平台" },
  { value: "host", label: "Host" }
] as const;
const MEASURE_OPTIONS = [
  { value: "requests", label: "请求" },
  { value: "total_tokens", label: "Token" }
] as const;

type SourceDimension = typeof SOURCE_OPTIONS[number]["value"];
type DistributionMeasure = typeof MEASURE_OPTIONS[number]["value"];

export function AnalyticsDashboardPage() {
  const [preset, setPreset] = useState<AnalyticsPreset>("24h");
  const [range, setRange] = useState(() => rangeForPreset("24h"));
  const [sourceDimension, setSourceDimension] = useState<SourceDimension>("platform");
  const [sourceMeasure, setSourceMeasure] = useState<DistributionMeasure>("requests");
  const [modelMeasure, setModelMeasure] = useState<DistributionMeasure>("requests");
  const stats = useLogStats(range, { includeOverview: true, transitionUpdates: true });
  const displayedPreset = stats.data ? presetForRange(stats.data.range) : preset;
  const granularity = displayedPreset === "24h" ? "hour" : "day";
  const trend = useMemo(
    () => stats.data ? groupTrend(stats.data, granularity) : [],
    [granularity, stats.data]
  );
  const platforms = useMemo(
    () => stats.data ? platformBreakdown(stats.data.by_route) : [],
    [stats.data]
  );
  const rangeLabel = PRESETS.find((item) => item.value === displayedPreset)?.label ?? "所选范围";
  const oneMinute = stats.data?.overview?.recent.one_minute;
  const fiveMinutes = stats.data?.overview?.recent.five_minutes;

  function selectPreset(next: AnalyticsPreset) {
    setPreset(next);
    setRange(rangeForPreset(next));
  }

  function refresh() {
    setRange(rangeForPreset(preset));
    stats.refresh();
  }

  return (
    <>
      <div className="page-header analytics-page-header">
        <div>
          <p className="eyebrow">仪表盘</p>
          <h2>流量与响应概况</h2>
        </div>
        <div className="analytics-header-actions">
          <div className="analytics-segmented" aria-label="历史统计范围">
            {PRESETS.map((item) => (
              <button
                type="button"
                className={preset === item.value ? "is-active" : ""}
                aria-pressed={preset === item.value}
                onClick={() => selectPreset(item.value)}
                key={item.value}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-sm" onClick={refresh}>刷新</button>
        </div>
      </div>

      <AnalyticsLoadState loading={stats.loading && !stats.data} error={stats.error} />

      {stats.data && (
        <div className="analytics-data-shell">
          <div
            className="analytics-data-view"
            aria-busy={stats.loading}
          >
            <AnalyticsMetricGrid items={[
              {
                label: `${rangeLabel}请求`,
                value: formatCompactMetricNumber(stats.data.summary.requests),
                exactValue: formatMetricNumber(stats.data.summary.requests),
                meta: `今日 ${formatCompactMetricNumber(stats.data.overview?.today.summary.requests ?? 0)} · 保留累计 ${formatCompactMetricNumber(stats.data.overview?.retained.summary.requests ?? 0)}`,
                tone: "is-request"
              },
              {
                label: `${rangeLabel} Token`,
                value: formatCompactMetricNumber(stats.data.summary.total_tokens),
                exactValue: formatMetricNumber(stats.data.summary.total_tokens),
                meta: `今日 ${formatCompactMetricNumber(stats.data.overview?.today.summary.total_tokens ?? 0)} · 保留累计 ${formatCompactMetricNumber(stats.data.overview?.retained.summary.total_tokens ?? 0)}`,
                tone: "is-token"
              },
              {
                label: "近 5 分钟缓存命中",
                value: cacheHitRate(
                  fiveMinutes?.input_tokens ?? 0,
                  fiveMinutes?.cache_read_tokens ?? 0
                ),
                meta: `${formatCompactMetricNumber(fiveMinutes?.cache_read_tokens ?? 0)} 读取`,
                tone: "is-cache"
              },
              {
                label: "近 5 分钟 RPM",
                value: `${(fiveMinutes?.average_rpm ?? 0).toFixed(2)} RPM`,
                meta: (
                  <>
                    <span>
                      近 5 分钟 {formatCompactMetricNumber(Math.round(
                        fiveMinutes?.average_tpm ?? 0
                      ))} TPM
                    </span>
                    <span>
                      近 1 分钟 {(oneMinute?.requests ?? 0).toFixed(2)} RPM
                      {" · "}
                      {formatCompactMetricNumber(oneMinute?.total_tokens ?? 0)} TPM
                    </span>
                  </>
                )
              },
              {
                label: "近 5 分钟首 Token P50 / P95",
                value: durationPair(
                  fiveMinutes?.first_token_p50_ms ?? null,
                  fiveMinutes?.first_token_p95_ms ?? null
                ),
                meta: `平均 ${formatDurationMs(roundMetric(fiveMinutes?.average_first_token_ms ?? null))}`
              },
              {
                label: "近 5 分钟总耗时 P50 / P95",
                value: durationPair(
                  fiveMinutes?.duration_p50_ms ?? null,
                  fiveMinutes?.duration_p95_ms ?? null
                ),
                meta: `平均 ${formatDurationMs(roundMetric(fiveMinutes?.average_duration_ms ?? null))}`
              }
            ]} />

            <div className="analytics-chart-grid">
              <AnalyticsPanel title="请求趋势" meta={granularity === "hour" ? "按小时" : "按天"}>
                <AnalyticsTrendChart points={trend} metric="requests" />
              </AnalyticsPanel>
              <AnalyticsPanel title="Token 趋势" meta={granularity === "hour" ? "按小时" : "按天"}>
                <AnalyticsTrendChart points={trend} metric="total_tokens" />
              </AnalyticsPanel>
            </div>

            <div className="analytics-breakdown-grid">
              <AnalyticsPanel
                title="来源分布"
                actions={(
                  <div className="analytics-panel-controls">
                    <AnalyticsSegmented
                      label="来源维度"
                      value={sourceDimension}
                      options={SOURCE_OPTIONS}
                      onChange={setSourceDimension}
                    />
                    <AnalyticsSegmented
                      label="来源度量"
                      value={sourceMeasure}
                      options={MEASURE_OPTIONS}
                      onChange={setSourceMeasure}
                    />
                  </div>
                )}
              >
                <AnalyticsDistribution rows={(sourceDimension === "platform"
                  ? platforms.map((row) => ({
                      ...row,
                      tone: row.label === "Claude" ? "is-claude" : "is-primary"
                    }))
                  : stats.data.by_host.map((row) => ({ label: row.host, ...row })))
                  .map((row) => ({
                    label: row.label,
                    value: row[sourceMeasure],
                    meta: sourceMeasure === "requests"
                      ? `${formatCompactMetricNumber(row.error_requests)} 错误 · ${formatCompactMetricNumber(row.total_tokens)} Token`
                      : `${formatCompactMetricNumber(row.requests)} 请求 · ${formatCompactMetricNumber(row.error_requests)} 错误`,
                    tone: "tone" in row ? row.tone : undefined
                  }))} />
              </AnalyticsPanel>
              <AnalyticsPanel
                title="响应模型"
                actions={(
                  <AnalyticsSegmented
                    label="模型分布度量"
                    value={modelMeasure}
                    options={MEASURE_OPTIONS}
                    onChange={setModelMeasure}
                  />
                )}
              >
                <AnalyticsDistribution rows={stats.data.by_model.map((row) => ({
                  label: row.model ?? "未识别模型",
                  value: row[modelMeasure],
                  meta: modelMeasure === "requests"
                    ? `${formatCompactMetricNumber(row.total_tokens)} Token`
                    : `${formatCompactMetricNumber(row.requests)} 请求`
                }))} />
              </AnalyticsPanel>
            </div>

            <AnalyticsPanel title="模型路径" meta="Host · 请求模型 → 上游模型 → 响应模型">
              {stats.data.model_mappings.length === 0 ? (
                <div className="analytics-inline-empty">暂无模型映射数据</div>
              ) : (
                <div className="analytics-table-scroll">
                  <table className="analytics-table">
                    <thead>
                      <tr>
                        <th scope="col">Host</th>
                        <th scope="col">请求模型</th>
                        <th scope="col">上游模型</th>
                        <th scope="col">响应模型</th>
                        <th scope="col">请求</th>
                        <th scope="col">错误</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.data.model_mappings.map((row, index) => (
                        <tr key={`${row.host}-${row.source_model}-${row.target_model}-${row.response_model}-${index}`}>
                          <td><code>{row.host}</code></td>
                          <td><code>{row.source_model ?? "-"}</code></td>
                          <td><code>{row.target_model ?? "-"}</code></td>
                          <td><code>{row.response_model ?? "-"}</code></td>
                          <td>{formatMetricNumber(row.requests)}</td>
                          <td className={row.error_requests > 0 ? "is-error" : undefined}>
                            {formatMetricNumber(row.error_requests)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AnalyticsPanel>

            <RetainedRange stats={stats.data} />
          </div>
        </div>
      )}
    </>
  );
}

function roundMetric(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
