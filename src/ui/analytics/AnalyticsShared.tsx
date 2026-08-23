import type { CSSProperties, ReactNode } from "react";
import type { LogStatsSnapshot } from "../../shared/types.js";
import {
  formatCompactMetricNumber,
  formatDurationMs,
  formatMetricNumber
} from "../shared/format.js";
import type { AnalyticsTrendPoint } from "./analytics-data.js";

export function AnalyticsMetricGrid({
  items
}: {
  items: Array<{
    label: string;
    value: string;
    meta: ReactNode;
    tone?: string;
    exactValue?: string;
  }>;
}) {
  return (
    <div className="analytics-metric-grid">
      {items.map((item) => (
        <article className={`analytics-metric ${item.tone ?? ""}`} key={item.label}>
          <span>{item.label}</span>
          <strong title={item.exactValue}>{item.value}</strong>
          <small>{item.meta}</small>
        </article>
      ))}
    </div>
  );
}

export function AnalyticsPanel({
  title,
  meta,
  actions,
  className = "",
  children
}: {
  title: string;
  meta?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card analytics-panel ${className}`}>
      <div className="card-header">
        <h3>{title}</h3>
        {(meta || actions) && (
          <div className="analytics-panel-header-side">
            {meta && <span className="analytics-panel-meta">{meta}</span>}
            {actions}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

export function AnalyticsSegmented<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="analytics-segmented analytics-panel-segmented" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          className={value === option.value ? "is-active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          key={option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function AnalyticsTrendChart({
  points,
  metric
}: {
  points: AnalyticsTrendPoint[];
  metric: "requests" | "total_tokens";
}) {
  const width = 720;
  const height = 236;
  const inset = { top: 18, right: 18, bottom: 30, left: 52 };
  const values = points.map((point) => point[metric]);
  const errors = metric === "requests" ? points.map((point) => point.error_requests) : [];
  const max = Math.max(1, ...values, ...errors);
  const x = (index: number) => inset.left +
    (points.length <= 1 ? 0 : index / (points.length - 1)) * (width - inset.left - inset.right);
  const y = (value: number) => inset.top +
    (1 - value / max) * (height - inset.top - inset.bottom);
  const requestLine = points.map((point, index) => `${x(index)},${y(point[metric])}`).join(" ");
  const errorLine = errors.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const tickIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]
    .filter((index) => index >= 0);

  if (points.length === 0 || values.every((value) => value === 0)) {
    return (
      <div className="analytics-chart-empty">
        <strong>当前区间暂无数据</strong>
        <span>统计仅包含 SQLite 中仍保留的请求记录。</span>
      </div>
    );
  }

  return (
    <div className="analytics-chart-wrap">
      <div className="analytics-chart-legend" aria-hidden="true">
        <span className="is-primary">{metric === "requests" ? "请求" : "Token"}</span>
        {metric === "requests" && <span className="is-error">错误</span>}
      </div>
      <svg
        className="analytics-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={metric === "requests" ? "请求与错误趋势" : "Token 使用趋势"}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = max * ratio;
          const tickY = y(value);
          return (
            <g key={ratio}>
              <line x1={inset.left} x2={width - inset.right} y1={tickY} y2={tickY} />
              <text x={inset.left - 8} y={tickY + 4} textAnchor="end">
                {formatCompactMetricNumber(Math.round(value))}
              </text>
            </g>
          );
        })}
        <polyline className="analytics-chart-line is-primary" points={requestLine} />
        {metric === "requests" && (
          <polyline className="analytics-chart-line is-error" points={errorLine} />
        )}
        {points.map((point, index) => (
          <circle
            className="analytics-chart-point"
            cx={x(index)}
            cy={y(point[metric])}
            r="3"
            key={point.key}
          />
        ))}
        {/* The 3px dot is too small to hit, especially on touch where there is no
            hover at all, so the tooltip lives on a transparent 7px target — the
            same pairing the token chart below already uses. */}
        {points.map((point, index) => (
          <circle
            className="analytics-chart-hit-target"
            cx={x(index)}
            cy={y(point[metric])}
            r="7"
            key={`${point.key}-hit`}
          >
            <title>{`${point.label}: ${formatMetricNumber(point[metric])}${metric === "requests" ? `，错误 ${point.error_requests}` : " Token"}`}</title>
          </circle>
        ))}
        {tickIndexes.map((index) => (
          <text
            className="analytics-chart-x-label"
            x={x(index)}
            y={height - 6}
            textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
            key={points[index].key}
          >
            {points[index].label}
          </text>
        ))}
      </svg>
    </div>
  );
}

const TOKEN_SERIES = [
  { metric: "input_tokens", label: "输入", tone: "is-input" },
  { metric: "output_tokens", label: "输出", tone: "is-output" },
  { metric: "cache_read_tokens", label: "缓存读取", tone: "is-cache-read" },
  { metric: "cache_creation_tokens", label: "缓存创建", tone: "is-cache-creation" }
] as const;

export function AnalyticsTokenBreakdownChart({ points }: { points: AnalyticsTrendPoint[] }) {
  const width = 720;
  const height = 252;
  const inset = { top: 18, right: 50, bottom: 30, left: 56 };
  const values = TOKEN_SERIES.flatMap((series) => points.map((point) => point[series.metric]));
  const max = Math.max(1, ...values);
  const x = (index: number) => inset.left +
    (points.length <= 1 ? 0 : index / (points.length - 1)) * (width - inset.left - inset.right);
  const tokenY = (value: number) => inset.top +
    (1 - value / max) * (height - inset.top - inset.bottom);
  const rate = (point: AnalyticsTrendPoint) => point.input_tokens === 0
    ? 0
    : Math.min(100, (point.cache_read_tokens / point.input_tokens) * 100);
  const rateY = (value: number) => inset.top +
    (1 - value / 100) * (height - inset.top - inset.bottom);
  const tickIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]
    .filter((index) => index >= 0);

  if (points.length === 0 || values.every((value) => value === 0)) {
    return (
      <div className="analytics-chart-empty">
        <strong>当前区间暂无 Token 数据</strong>
        <span>统计仅包含 SQLite 中仍保留且记录到用量的请求。</span>
      </div>
    );
  }

  return (
    <div className="analytics-chart-wrap">
      <div className="analytics-chart-legend is-token-breakdown" aria-hidden="true">
        {TOKEN_SERIES.map((series) => (
          <span className={series.tone} key={series.metric}>{series.label}</span>
        ))}
        <span className="is-cache-rate">缓存率</span>
      </div>
      <svg
        className="analytics-chart analytics-token-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="输入、输出、缓存读取、缓存创建与缓存命中率趋势"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = max * ratio;
          const tickY = tokenY(value);
          return (
            <g key={ratio}>
              <line x1={inset.left} x2={width - inset.right} y1={tickY} y2={tickY} />
              <text x={inset.left - 8} y={tickY + 4} textAnchor="end">
                {formatCompactMetricNumber(Math.round(value))}
              </text>
              <text
                className="analytics-chart-rate-axis"
                x={width - inset.right + 8}
                y={tickY + 4}
                textAnchor="start"
              >
                {Math.round(ratio * 100)}%
              </text>
            </g>
          );
        })}
        {TOKEN_SERIES.map((series) => (
          <polyline
            className={`analytics-chart-line ${series.tone}`}
            points={points.map((point, index) => `${x(index)},${tokenY(point[series.metric])}`).join(" ")}
            key={series.metric}
          />
        ))}
        <polyline
          className="analytics-chart-line is-cache-rate"
          points={points.map((point, index) => `${x(index)},${rateY(rate(point))}`).join(" ")}
        />
        {points.map((point, index) => (
          <circle
            className="analytics-chart-hit-target"
            cx={x(index)}
            cy={tokenY(point.cache_read_tokens)}
            r="7"
            key={point.key}
          >
            <title>{`${point.label}：输入 ${formatMetricNumber(point.input_tokens)}，输出 ${formatMetricNumber(point.output_tokens)}，缓存读取 ${formatMetricNumber(point.cache_read_tokens)}，缓存创建 ${formatMetricNumber(point.cache_creation_tokens)}，缓存率 ${cacheHitRate(point.input_tokens, point.cache_read_tokens)}`}</title>
          </circle>
        ))}
        {tickIndexes.map((index) => (
          <text
            className="analytics-chart-x-label"
            x={x(index)}
            y={height - 6}
            textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
            key={points[index].key}
          >
            {points[index].label}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function AnalyticsDistribution({
  rows
}: {
  rows: Array<{ label: string; value: number; meta?: string; tone?: string }>;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  if (rows.length === 0) {
    return <div className="analytics-inline-empty">暂无分布数据</div>;
  }

  return (
    <div className="analytics-distribution">
      {rows.map((row) => (
        <div className="analytics-distribution-row" key={row.label}>
          <div className="analytics-distribution-label">
            <span title={row.label}>{row.label}</span>
            <strong title={formatMetricNumber(row.value)}>{formatCompactMetricNumber(row.value)}</strong>
          </div>
          <div className="analytics-distribution-track">
            <span
              className={row.tone ?? ""}
              style={{ "--analytics-share": `${(row.value / max) * 100}%` } as CSSProperties}
            />
          </div>
          {row.meta && <small>{row.meta}</small>}
        </div>
      ))}
    </div>
  );
}

export function AnalyticsLoadState({
  loading,
  error
}: {
  loading: boolean;
  error: string | null;
}) {
  if (error) {
    return <div className="error-banner" role="alert">{error}</div>;
  }
  if (!loading) {
    return null;
  }
  return (
    <div className="analytics-loading" role="status" aria-live="polite">
      {/* A <p>, not a <span>: `.analytics-loading span` is the skeleton box. The
          boxes carry no text, so the live region had nothing to announce. */}
      <p className="visually-hidden">正在加载统计数据。</p>
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

export function RetainedRange({ stats }: { stats: LogStatsSnapshot }) {
  const oldest = stats.retained_range.oldest_at;
  const newest = stats.retained_range.newest_at;
  return (
    <span className="analytics-retained-range">
      {oldest && newest
        ? `SQLite 保留记录 ${formatShortDate(oldest)} - ${formatShortDate(newest)}`
        : "SQLite 暂无保留记录"}
    </span>
  );
}

export function cacheRate(stats: LogStatsSnapshot): string {
  return cacheHitRate(stats.summary.input_tokens, stats.summary.cache_read_tokens);
}

export function cacheHitRate(inputTokens: number, cacheReadTokens: number): string {
  return inputTokens === 0
    ? "-"
    : `${Math.min(100, (cacheReadTokens / inputTokens) * 100).toFixed(1)}%`;
}

export function durationPair(p50: number | null, p95: number | null): string {
  return `${formatDurationMs(p50)} / ${formatDurationMs(p95)}`;
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}
