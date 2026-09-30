import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatDateTime, formatDurationMs, formatMetricNumber } from "../shared/format.js";
import { errorSummary } from "../shared/api.js";
import {
  cacheCreationInputTokens,
  cacheReadInputTokens,
  cachedInputTotalTokens,
  displayInputTokens,
  displayTotalTokens,
  formatCacheHitRate,
  hasAdditiveCachedInput,
  logStatusToneClass,
  logStatusKind,
  totalInputTokens,
  responseModelDisplay,
  responseModelSourceLabel,
  compactionDetectionLabel,
  compactionModeClass,
  compactionModeLabel,
  codexClientDisplay
} from "./log-utils.js";
import { LogCaptureViewer } from "./LogCaptureViewer.js";
import { outputThroughputLabel } from "./LogSummary.js";
import { hasResponseModelMismatch } from "./log-utils.js";

function CopyValue({ value }: { value: string }) {
  const [copyResult, setCopyResult] = useState("");
  const copied = copyResult === "已复制";
  const copyVersion = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    copyVersion.current++;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
  }, []);

  async function handleCopy() {
    const version = ++copyVersion.current;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setCopyResult("正在复制…");
    try {
      if (!navigator.clipboard) throw new Error("当前浏览器不支持剪贴板");
      await navigator.clipboard.writeText(value);
      if (version !== copyVersion.current) return;
      setCopyResult("已复制");
      timerRef.current = setTimeout(() => setCopyResult(""), 1600);
    } catch (error) {
      if (version === copyVersion.current) {
        setCopyResult(`复制失败：${errorSummary(error)}。请重试，或手动选择请求 ID。`);
      }
    }
  }

  return (
    <span className="log-copy-value">
      {value}
      <button
        className={`log-copy-button ${copied ? "is-copied" : ""}`}
        type="button"
        aria-label="复制请求 ID"
        onClick={() => void handleCopy()}
      >
        {copied ? "已复制" : "复制"}
      </button>
      <span className={copyResult.startsWith("复制失败") ? "log-copy-feedback" : "visually-hidden"} role="status">{copyResult}</span>
    </span>
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="log-detail-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function LogDetailPanel({ entry, onCollapse }: {
  entry: RequestLogEntry;
  onCollapse?: () => void;
}) {
  const hasError = logStatusKind(entry) === "error";
  return (
    <div className="log-detail-panel">
      <header className="log-detail-header">
        <div className="log-detail-identity">
          <div className="log-detail-title">
            <h3>{entry.method} {entry.path}</h3>
            <span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>
            <span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span>
          </div>
          <div className="log-detail-request-id">
            <span>请求 ID</span><CopyValue value={entry.request_id} />
          </div>
        </div>
        {onCollapse && <button className="log-detail-close" type="button" onClick={onCollapse}>
          收起详情 <span aria-hidden="true">⌃</span>
        </button>}
      </header>

      {hasError && <section className="log-detail-error" aria-label="错误信息">
        <strong>请求异常</strong>
        <p>{entry.error_summary ?? [`HTTP ${entry.status}`, entry.stream_outcome, entry.stream_terminal_event].filter(Boolean).join(" · ")}</p>
      </section>}

      <section className="log-detail-performance" aria-label="性能">
        <dl className="log-detail-metrics">
          <DetailField label="首响应（首个数据块）">{formatDurationMs(entry.first_token_ms)}</DetailField>
          <DetailField label="总耗时">{formatDurationMs(entry.duration_ms)}</DetailField>
          <DetailField label="平均输出吞吐">{outputThroughputLabel(entry)}</DetailField>
        </dl>
        <p className="log-detail-note">吞吐 = 输出 Token / 总耗时，包含等待，非纯生成速度</p>
      </section>

      <section className="log-detail-section" aria-label="路由与模型">
        <div className="log-detail-section-head">
          <h3>路由与模型</h3>
          <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
        </div>
        <dl className="log-detail-fields">
          <DetailField label="源模型">{entry.source_model ?? "-"}</DetailField>
          <DetailField label="目标模型">{entry.target_model ?? entry.source_model ?? "-"}</DetailField>
          <DetailField label="有效响应模型">
            <strong className="log-detail-model">{responseModelDisplay(entry)}</strong>
          </DetailField>
          <DetailField label="上游声明模型">{entry.response_model ?? "未声明"}</DetailField>
          <DetailField label="模型来源">
            {responseModelSourceLabel(entry)}
            {hasResponseModelMismatch(entry) && <span className="log-detail-mismatch">响应声明不同</span>}
          </DetailField>
          <DetailField label="上游 Host">{entry.upstream_host}</DetailField>
          <DetailField label="上游凭据标签">{entry.key_name ?? "—"}</DetailField>
          <DetailField label="端点">{entry.endpoint}</DetailField>
          <DetailField label="推理强度">{entry.reasoning_effort ?? "无"}</DetailField>
          {entry.compaction_mode && <DetailField label="压缩模式">
            <span className={`protocol-chip ${compactionModeClass(entry.compaction_mode)}`}>{compactionModeLabel(entry.compaction_mode)}</span>
          </DetailField>}
          {entry.compaction_detection_source && <DetailField label="判定来源">{compactionDetectionLabel(entry)}</DetailField>}
        </dl>
      </section>

      <section className="log-detail-section" aria-label="Token 明细">
        <div className="log-detail-section-head">
          <h3>Token 明细 <span className="log-detail-total">{formatMetricNumber(displayTotalTokens(entry))}</span></h3>
          <span className="log-detail-note">{formatCacheHitRate(entry)} 缓存命中</span>
        </div>
        <dl className="log-detail-fields is-token-fields">
          <DetailField label="输入">{formatMetricNumber(displayInputTokens(entry))}</DetailField>
          <DetailField label="输出">{formatMetricNumber(entry.output_tokens)}</DetailField>
          <DetailField label={hasAdditiveCachedInput(entry) ? "缓存读取" : "缓存输入"}>
            {formatMetricNumber(cacheReadInputTokens(entry))}
          </DetailField>
          {cacheCreationInputTokens(entry) !== null && <DetailField label="缓存写入">
            {formatMetricNumber(cacheCreationInputTokens(entry))}
          </DetailField>}
          {hasAdditiveCachedInput(entry) && <DetailField label="缓存合计">
            {formatMetricNumber(cachedInputTotalTokens(entry))}
          </DetailField>}
          <DetailField label="总输入">{formatMetricNumber(totalInputTokens(entry))}</DetailField>
          <DetailField label="缓存输出">{formatMetricNumber(entry.cached_output_tokens)}</DetailField>
          <DetailField label="推理">{formatMetricNumber(entry.reasoning_tokens)}</DetailField>
          <DetailField label="原始总量">{formatMetricNumber(entry.total_tokens)}</DetailField>
        </dl>
      </section>

      <details className="log-detail-diagnostics">
        <summary>传输与客户端 <span>时间、流状态与请求上下文</span></summary>
        <dl className="log-detail-fields">
          <DetailField label="开始时间">{formatDateTime(entry.time)}</DetailField>
          <DetailField label="完成时间">{formatDateTime(entry.completed_at)}</DetailField>
          <DetailField label="上游状态">{entry.upstream_status ?? "-"}</DetailField>
          <DetailField label="流完成">{entry.stream_terminal_event ?? "-"}</DetailField>
          <DetailField label="断开阶段">{entry.client_disconnect_phase ?? "none"}</DetailField>
          <DetailField label="结果分类">{entry.stream_outcome ?? "-"}</DetailField>
          <DetailField label="超大流事件">{entry.stream_oversized_event_count ?? 0}</DetailField>
          <DetailField label="响应缓冲">{entry.upstream_response_truncated ? "已截断" : "完整"}</DetailField>
          {entry.codex_client && <DetailField label="Codex 客户端">{codexClientDisplay(entry)}</DetailField>}
          <DetailField label="User Agent">{entry.user_agent ?? "-"}</DetailField>
          <DetailField label="请求摘要">{entry.request_summary ?? "无"}</DetailField>
          {entry.compact_response_normalized && <DetailField label="Compact 响应替换">
            {entry.compact_response_normalize_reason ?? "normalized"}
            {" / "}
            {entry.compact_response_synthetic_source ?? "unknown"}
          </DetailField>}
        </dl>
      </details>

      <LogCaptureViewer entry={entry} />
    </div>
  );
}
