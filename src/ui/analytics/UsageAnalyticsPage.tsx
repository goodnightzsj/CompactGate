import { useMemo, useState } from "react";
import type { StudioPage } from "../app-types.js";
import { formatCompactMetricNumber, formatMetricNumber } from "../shared/format.js";
import {
  AnalyticsDistribution,
  AnalyticsEmptyState,
  AnalyticsLoadState,
  AnalyticsMetricGrid,
  AnalyticsPanel,
  AnalyticsRefreshStatus,
  AnalyticsSegmented,
  AnalyticsTokenBreakdownChart,
  RetainedRange,
  cacheHitRate,
  cacheRate
} from "./AnalyticsShared.js";
import {
  dateInputsToRange,
  defaultUsageDates,
  downloadUsageCsv,
  groupTrend,
  inputDate,
  type AnalyticsGranularity,
  useLogStats
} from "./analytics-data.js";
import { DateRangePicker } from "./DateRangePicker.js";

export interface UsagePreferences {
  from: string;
  to: string;
  granularity: AnalyticsGranularity;
  endpointMeasure: "requests" | "total_tokens";
}

export function UsageAnalyticsPage({ preferences, onPreferencesChange, onNavigate }: {
  preferences: UsagePreferences | null;
  onPreferencesChange: (preferences: UsagePreferences) => void;
  onNavigate: (page: StudioPage) => void;
}) {
  const defaults = useMemo(() => defaultUsageDates(), []);
  const current: UsagePreferences = preferences ?? { ...defaults, granularity: "day", endpointMeasure: "requests" };
  const { from: fromDate, to: toDate, granularity, endpointMeasure } = current;
  const range = useMemo(() => dateInputsToRange(fromDate, toDate), [fromDate, toDate]);
  const [formError, setFormError] = useState<string | null>(null);
  const stats = useLogStats(range);
  const matchesSelectedRange = stats.data?.range.from === range.from && stats.data.range.to === range.to;
  const trend = useMemo(
    () => stats.data ? groupTrend(stats.data, granularity) : [],
    [granularity, stats.data]
  );

  function applyRange(from: string, to: string) {
    try {
      dateInputsToRange(from, to);
      onPreferencesChange({ ...current, from, to });
      setFormError(null);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "日期范围无效。");
    }
  }

  return (
    <>
      <div className="page-header analytics-page-header">
        <div>
          <p className="eyebrow">用量</p>
          <h2>保留日志用量</h2>
        </div>
        <div className="analytics-header-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!matchesSelectedRange || trend.length === 0}
            onClick={() => downloadUsageCsv(trend)}
          >
            导出 CSV
          </button>
          <button type="button" className="btn btn-sm analytics-refresh" disabled={stats.loading} onClick={stats.refresh}>{stats.loading ? "刷新中..." : "刷新"}</button>
        </div>
      </div>

      <div className="usage-filter-bar">
        <DateRangePicker from={fromDate} to={toDate} onApply={applyRange} />
        <div className="usage-granularity-field">
          <span>粒度</span>
          <div className="analytics-segmented" role="group" aria-label="用量粒度">
            <button
              type="button"
              className={granularity === "hour" ? "is-active" : ""}
              aria-pressed={granularity === "hour"}
              onClick={() => onPreferencesChange({ ...current, granularity: "hour" })}
            >
              小时
            </button>
            <button
              type="button"
              className={granularity === "day" ? "is-active" : ""}
              aria-pressed={granularity === "day"}
              onClick={() => onPreferencesChange({ ...current, granularity: "day" })}
            >
              天
            </button>
          </div>
        </div>
      </div>

      {formError && <div className="error-banner" role="alert">{formError}</div>}
      <AnalyticsLoadState loading={stats.loading && !stats.data} error={stats.error} />
      <AnalyticsRefreshStatus loading={stats.loading} error={stats.error} generatedAt={stats.data?.generated_at ?? null} />
      {stats.data && !matchesSelectedRange && (
        <p className="usage-range-notice" role="status">
          当前显示 {inputDate(new Date(stats.data.range.from))} — {inputDate(new Date(Date.parse(stats.data.range.to) - 1))} 的上次统计；所选范围加载完成后可导出。
        </p>
      )}

      {stats.data && (
        <>
          <section className="usage-metric-grid" aria-label="用量摘要">
            <AnalyticsMetricGrid items={[
            {
              label: "总 Token",
              value: formatCompactMetricNumber(stats.data.summary.total_tokens),
              exactValue: formatMetricNumber(stats.data.summary.total_tokens),
              meta: `${formatCompactMetricNumber(stats.data.summary.usage_observed_requests)} 条有用量`,
              tone: "is-token"
            },
            {
              label: "缓存率",
              value: cacheRate(stats.data),
              meta: `${formatCompactMetricNumber(stats.data.summary.cache_read_tokens)} 读取`,
              tone: "is-cache"
            },
            {
              label: "请求",
              value: formatCompactMetricNumber(stats.data.summary.requests),
              exactValue: formatMetricNumber(stats.data.summary.requests),
              meta: `${formatCompactMetricNumber(stats.data.summary.error_requests)} 错误`,
              tone: "is-request"
            }
            ]} />
          </section>

          <section className="analytics-metric-section usage-token-metrics" aria-labelledby="usage-token-heading">
            <div className="analytics-metric-section-header">
              <h3 id="usage-token-heading">Token 构成</h3>
              <span>输入、输出与缓存</span>
            </div>
            <AnalyticsMetricGrid items={[
            {
              label: "总输入",
              value: formatCompactMetricNumber(stats.data.summary.input_tokens),
              exactValue: formatMetricNumber(stats.data.summary.input_tokens),
              meta: "含缓存输入"
            },
            {
              label: "输出",
              value: formatCompactMetricNumber(stats.data.summary.output_tokens),
              exactValue: formatMetricNumber(stats.data.summary.output_tokens),
              meta: `${formatCompactMetricNumber(stats.data.summary.reasoning_tokens)} 推理`
            },
            {
              label: "缓存读取",
              value: formatCompactMetricNumber(stats.data.summary.cache_read_tokens),
              exactValue: formatMetricNumber(stats.data.summary.cache_read_tokens),
              meta: "已复用输入"
            },
            {
              label: "缓存创建",
              value: formatCompactMetricNumber(stats.data.summary.cache_creation_tokens),
              exactValue: formatMetricNumber(stats.data.summary.cache_creation_tokens),
              meta: "新增缓存输入"
            }
            ]} />
          </section>

          {stats.data.summary.requests === 0 ? (
            <AnalyticsEmptyState hasRetainedLogs={stats.data.retained_range.oldest_at !== null} onNavigate={onNavigate} />
          ) : <>
          <AnalyticsPanel title="Token 趋势" meta={granularity === "hour" ? "按小时" : "按天"}>
            <AnalyticsTokenBreakdownChart points={trend} />
          </AnalyticsPanel>

          <AnalyticsPanel title="时段明细" meta={`${trend.length} 个${granularity === "hour" ? "小时" : "日期"}`}>
            <div className="analytics-table-scroll">
              <table className="analytics-table analytics-usage-table">
                <thead>
                  <tr>
                    <th scope="col">时段</th>
                    <th scope="col">请求</th>
                    <th scope="col">错误</th>
                    <th scope="col">输入</th>
                    <th scope="col">输出</th>
                    <th scope="col">缓存读取</th>
                    <th scope="col">缓存创建</th>
                    <th scope="col">总 Token</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((point) => (
                    <tr key={point.key}>
                      <td><time dateTime={point.key}>{point.label}</time></td>
                      <td>{formatMetricNumber(point.requests)}</td>
                      <td className={point.error_requests > 0 ? "is-error" : ""}>
                        {formatMetricNumber(point.error_requests)}
                      </td>
                      <td>{formatMetricNumber(point.input_tokens)}</td>
                      <td>{formatMetricNumber(point.output_tokens)}</td>
                      <td>{formatMetricNumber(point.cache_read_tokens)}</td>
                      <td>{formatMetricNumber(point.cache_creation_tokens)}</td>
                      <td><strong>{formatMetricNumber(point.total_tokens)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnalyticsPanel>

          <div className="analytics-breakdown-grid">
            <AnalyticsPanel title="响应模型" meta="Top 12">
              <div className="analytics-table-scroll">
                <table className="analytics-table analytics-model-table">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      <th scope="col">请求</th>
                      <th scope="col">错误</th>
                      <th scope="col">缓存命中率</th>
                      <th scope="col">总 Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.data.by_model.map((row) => (
                      <tr key={row.model ?? "unknown"}>
                        <td><code>{row.model ?? "未识别模型"}</code></td>
                        <td>{formatMetricNumber(row.requests)}</td>
                        <td>{formatMetricNumber(row.error_requests)}</td>
                        <td>{cacheHitRate(row.input_tokens, row.cache_read_tokens)}</td>
                        <td>{formatMetricNumber(row.total_tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AnalyticsPanel>
            <AnalyticsPanel
              title="端点分布"
              actions={(
                <AnalyticsSegmented
                  label="端点分布度量"
                  value={endpointMeasure}
                  options={[
                    { value: "requests", label: "请求" },
                    { value: "total_tokens", label: "Token" }
                  ]}
                  onChange={(endpointMeasure) => onPreferencesChange({ ...current, endpointMeasure })}
                />
              )}
            >
              <AnalyticsDistribution rows={stats.data.by_endpoint.map((row) => ({
                label: row.endpoint,
                value: row[endpointMeasure],
                meta: endpointMeasure === "requests"
                  ? `${formatCompactMetricNumber(row.error_requests)} 错误 · ${formatCompactMetricNumber(row.total_tokens)} Token`
                  : `${formatCompactMetricNumber(row.requests)} 请求 · ${formatCompactMetricNumber(row.error_requests)} 错误`
              }))} />
            </AnalyticsPanel>
          </div>
          </>}

          <RetainedRange stats={stats.data} />
        </>
      )}
    </>
  );
}
