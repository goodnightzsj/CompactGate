import type { RequestLogEntry } from "../../shared/types.js";
import { formatCompactMetricNumber, formatDurationMs, formatMetricNumber } from "../shared/format.js";
import { averageOutputTokensPerSecond, hasResponseModelMismatch, responseModelSourceLabel } from "./log-utils.js";
import { displayTotalTokens, formatCacheHitRate, totalInputTokens } from "./log-token-metrics.js";

export function LogModelSummary({ entry }: { entry: RequestLogEntry }) {
  const rewritten = entry.target_model && entry.target_model !== entry.source_model;
  return <span className="log-summary-stack">
    <strong>{entry.source_model ?? "-"}</strong>
    {rewritten && <small>→ {entry.target_model}</small>}
    {hasResponseModelMismatch(entry)
      ? <small className="log-model-response log-model-difference">↳ {entry.response_model} · 响应声明不同</small>
      : <small className="log-model-response log-evidence-label">{responseModelSourceLabel(entry)}</small>}
  </span>;
}

export function LogTokenSummary({ entry }: { entry: RequestLogEntry }) {
  const cacheHitRate = formatCacheHitRate(entry);
  return <span className="log-summary-stack log-token-summary">
    <span className="log-token-head">
      <span className="token-total-pill">{formatCompactMetricNumber(displayTotalTokens(entry))}</span>
      {cacheHitRate !== "-" && <small className="log-cache-rate" title="缓存命中率">
        <span className="visually-hidden">缓存命中率 </span>{cacheHitRate}
      </small>}
    </span>
    <small className="log-token-breakdown">入 {formatCompactMetricNumber(totalInputTokens(entry))} · 出 {formatCompactMetricNumber(entry.output_tokens)}</small>
  </span>;
}

export function LogTimingSummary({ entry }: { entry: RequestLogEntry }) {
  return <span className="log-summary-stack">
    <span>总 {formatDurationMs(entry.duration_ms)}</span>
    <small>首 {formatDurationMs(entry.first_token_ms)}</small>
  </span>;
}

export function outputThroughputLabel(entry: RequestLogEntry): string {
  const rate = averageOutputTokensPerSecond(entry);
  return rate === null ? "-" : `${formatMetricNumber(Math.round(rate * 10) / 10)} tok/s`;
}
