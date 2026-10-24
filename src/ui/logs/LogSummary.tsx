import type { RequestLogEntry } from "../../shared/types.js";
import { generationTokensPerSecond, MIN_GENERATION_DURATION_MS } from "../../shared/generation-metrics.js";
import { formatCompactMetricNumber, formatDurationMs, formatMetricNumber } from "../shared/format.js";
import { averageOutputTokensPerSecond, hasResponseModelMismatch, responseModelSourceLabel } from "./log-utils.js";
import { displayTotalTokens, formatCacheHitRate, totalInputTokens } from "./log-token-metrics.js";

const GENERATION_RATE_NUMBER = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

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

export const GENERATION_THROUGHPUT_HINT = `生成速度 = 源流输出 Token / 首个有效输出至成功终态的耗时。排除首输出前等待和 HTTP 收尾；无可靠样本或不足 ${MIN_GENERATION_DURATION_MS}ms 时显示 -。这是代理观察值，上游缓冲或未展示的思考可能影响读数。`;

export function generationThroughputLabel(entry: RequestLogEntry): string {
  const rate = generationTokensPerSecond(entry.generation_sample);
  return rate === null ? "-" : `${GENERATION_RATE_NUMBER.format(rate)} tok/s`;
}

export function LogThroughputSummary({ entry }: { entry: RequestLogEntry }) {
  return <span>{generationThroughputLabel(entry)}</span>;
}
