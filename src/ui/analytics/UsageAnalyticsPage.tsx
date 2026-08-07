import { useMemo, useState } from "react";
import { formatMetricNumber } from "../shared/format.js";
import {
  AnalyticsDistribution,
  AnalyticsLoadState,
  AnalyticsMetricGrid,
  AnalyticsPanel,
  AnalyticsTrendChart,
  RetainedRange,
  cacheHitRate,
  cacheRate
} from "./AnalyticsShared.js";
import {
  dateInputsToRange,
  defaultUsageDates,
  downloadUsageCsv,
  groupTrend,
  type AnalyticsGranularity,
  useLogStats
} from "./analytics-data.js";
import { DateRangePicker } from "./DateRangePicker.js";

export function UsageAnalyticsPage() {
  const defaults = useMemo(() => defaultUsageDates(), []);
  const [fromDate, setFromDate] = useState(defaults.from);
  const [toDate, setToDate] = useState(defaults.to);
  const [range, setRange] = useState(() => dateInputsToRange(defaults.from, defaults.to));
  const [granularity, setGranularity] = useState<AnalyticsGranularity>("day");
  const [formError, setFormError] = useState<string | null>(null);
  const stats = useLogStats(range);
  const trend = useMemo(
    () => stats.data ? groupTrend(stats.data, granularity) : [],
    [granularity, stats.data]
  );

  function applyRange(from: string, to: string) {
    try {
      const nextRange = dateInputsToRange(from, to);
      setFromDate(from);
      setToDate(to);
      setRange(nextRange);
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
            disabled={trend.length === 0}
            onClick={() => downloadUsageCsv(trend)}
          >
            导出 CSV
          </button>
          <button type="button" className="btn btn-sm" onClick={stats.refresh}>刷新</button>
        </div>
      </div>

      <div className="usage-filter-bar">
        <DateRangePicker from={fromDate} to={toDate} onApply={applyRange} />
        <div className="usage-granularity-field">
          <span>粒度</span>
          <div className="analytics-segmented" aria-label="用量粒度">
            <button
              type="button"
              className={granularity === "hour" ? "is-active" : ""}
              aria-pressed={granularity === "hour"}
              onClick={() => setGranularity("hour")}
            >
              小时
            </button>
            <button
              type="button"
              className={granularity === "day" ? "is-active" : ""}
              aria-pressed={granularity === "day"}
              onClick={() => setGranularity("day")}
            >
              天
            </button>
          </div>
        </div>
      </div>

      {formError && <div className="error-banner" role="alert">{formError}</div>}
      <AnalyticsLoadState loading={stats.loading} error={stats.error} />

      {stats.data && (
        <>
          <div className="usage-metric-grid">
            <AnalyticsMetricGrid items={[
            {
              label: "总 Token",
              value: formatMetricNumber(stats.data.summary.total_tokens),
              meta: `${formatMetricNumber(stats.data.summary.usage_observed_requests)} 条有用量`,
              tone: "is-token"
            },
            {
              label: "总输入",
              value: formatMetricNumber(stats.data.summary.input_tokens),
              meta: "含缓存输入",
              tone: "is-request"
            },
            {
              label: "缓存率",
              value: cacheRate(stats.data),
              meta: `${formatMetricNumber(stats.data.summary.cache_read_tokens)} 读取`,
              tone: "is-cache"
            },
            {
              label: "输出",
              value: formatMetricNumber(stats.data.summary.output_tokens),
              meta: `${formatMetricNumber(stats.data.summary.reasoning_tokens)} 推理`
            },
            {
              label: "缓存读取",
              value: formatMetricNumber(stats.data.summary.cache_read_tokens),
              meta: "已复用输入",
              tone: "is-cache"
            },
            {
              label: "缓存创建",
              value: formatMetricNumber(stats.data.summary.cache_creation_tokens),
              meta: "新增缓存输入"
            },
            {
              label: "请求",
              value: formatMetricNumber(stats.data.summary.requests),
              meta: `${formatMetricNumber(stats.data.summary.error_requests)} 错误`
            }
            ]} />
          </div>

          <AnalyticsPanel title="Token 趋势" meta={granularity === "hour" ? "按小时" : "按天"}>
            <AnalyticsTrendChart points={trend} metric="total_tokens" />
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
                <table className="analytics-table">
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
            <AnalyticsPanel title="端点分布" meta="请求数">
              <AnalyticsDistribution rows={stats.data.by_endpoint.map((row) => ({
                label: row.endpoint,
                value: row.requests,
                meta: `${formatMetricNumber(row.error_requests)} 错误 · ${formatMetricNumber(row.total_tokens)} Token`
              }))} />
            </AnalyticsPanel>
          </div>

          <RetainedRange stats={stats.data} />
        </>
      )}
    </>
  );
}
