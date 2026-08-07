import { useMemo, useState } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import { formatDurationMs, formatMetricNumber } from "../shared/format.js";
import {
  AnalyticsDistribution,
  AnalyticsLoadState,
  AnalyticsMetricGrid,
  AnalyticsPanel,
  AnalyticsTrendChart,
  cacheRate,
  durationPair,
  RetainedRange,
  successRate
} from "./AnalyticsShared.js";
import {
  groupTrend,
  rangeForPreset,
  type AnalyticsPreset,
  useLogStats
} from "./analytics-data.js";

const PRESETS: Array<{ value: AnalyticsPreset; label: string }> = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" }
];

export function AnalyticsDashboardPage() {
  const [preset, setPreset] = useState<AnalyticsPreset>("24h");
  const [range, setRange] = useState(() => rangeForPreset("24h"));
  const stats = useLogStats(range);
  const granularity = preset === "24h" ? "hour" : "day";
  const trend = useMemo(
    () => stats.data ? groupTrend(stats.data, granularity) : [],
    [granularity, stats.data]
  );

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
          <div className="analytics-segmented" aria-label="统计范围">
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

      <AnalyticsLoadState loading={stats.loading} error={stats.error} />

      {stats.data && (
        <>
          <AnalyticsMetricGrid items={[
            {
              label: "请求",
              value: formatMetricNumber(stats.data.summary.requests),
              meta: `${successRate(stats.data)} 正常 · ${formatMetricNumber(stats.data.summary.error_requests)} 错误`,
              tone: "is-request"
            },
            {
              label: "Token",
              value: formatMetricNumber(stats.data.summary.total_tokens),
              meta: `${formatMetricNumber(stats.data.summary.usage_observed_requests)} 条记录到用量`,
              tone: "is-token"
            },
            {
              label: "缓存命中",
              value: cacheRate(stats.data),
              meta: `${formatMetricNumber(stats.data.summary.cache_read_tokens)} 读取`,
              tone: "is-cache"
            },
            {
              label: "平均速率",
              value: `${stats.data.summary.average_rpm.toFixed(2)} RPM`,
              meta: `${formatMetricNumber(Math.round(stats.data.summary.average_tpm))} TPM`
            },
            {
              label: "首 Token P50 / P95",
              value: durationPair(
                stats.data.summary.first_token_p50_ms,
                stats.data.summary.first_token_p95_ms
              ),
              meta: `平均 ${formatDurationMs(roundMetric(stats.data.summary.average_first_token_ms))}`
            },
            {
              label: "总耗时 P50 / P95",
              value: durationPair(
                stats.data.summary.duration_p50_ms,
                stats.data.summary.duration_p95_ms
              ),
              meta: `平均 ${formatDurationMs(roundMetric(stats.data.summary.average_duration_ms))}`
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
            <AnalyticsPanel title="路由分布" meta="请求数">
              <AnalyticsDistribution rows={stats.data.by_route.map((row) => ({
                label: routeLabel(row.route),
                value: row.requests,
                meta: `${formatMetricNumber(row.error_requests)} 错误 · ${formatMetricNumber(row.total_tokens)} Token`,
                tone: `is-${row.route}`
              }))} />
            </AnalyticsPanel>
            <AnalyticsPanel title="响应模型" meta="Top 12">
              <AnalyticsDistribution rows={stats.data.by_model.map((row) => ({
                label: row.model ?? "未识别模型",
                value: row.requests,
                meta: `${formatMetricNumber(row.total_tokens)} Token`
              }))} />
            </AnalyticsPanel>
          </div>

          <AnalyticsPanel title="模型路径" meta="请求模型 → 上游模型 → 响应模型">
            {stats.data.model_mappings.length === 0 ? (
              <div className="analytics-inline-empty">暂无模型映射数据</div>
            ) : (
              <div className="analytics-table-scroll">
                <table className="analytics-table">
                  <thead>
                    <tr>
                      <th scope="col">请求模型</th>
                      <th scope="col">上游模型</th>
                      <th scope="col">响应模型</th>
                      <th scope="col">请求</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.data.model_mappings.map((row, index) => (
                      <tr key={`${row.source_model}-${row.target_model}-${row.response_model}-${index}`}>
                        <td><code>{row.source_model ?? "-"}</code></td>
                        <td><code>{row.target_model ?? "-"}</code></td>
                        <td><code>{row.response_model ?? "-"}</code></td>
                        <td>{formatMetricNumber(row.requests)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AnalyticsPanel>

          <RetainedRange stats={stats.data} />
        </>
      )}
    </>
  );
}

function roundMetric(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
