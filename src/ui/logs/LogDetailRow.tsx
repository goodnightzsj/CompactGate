import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatDateTime, formatDurationMs, formatMetricNumber } from "../shared/format.js";
import {
  cacheCreationInputTokens,
  cacheReadInputTokens,
  cachedInputTotalTokens,
  displayInputTokens,
  displayTotalTokens,
  formatCacheHitRate,
  hasAdditiveCachedInput,
  logStatusToneClass,
  totalInputTokens
} from "./log-utils.js";
import { LogCaptureViewer } from "./LogCaptureViewer.js";

export function LogDetailRow({ entry }: { entry: RequestLogEntry }) {
  return (
    <tr className="log-detail-row">
      <td colSpan={10}>
        <div className="log-detail-panel">
          <section className="log-detail-section is-primary" aria-label="请求上下文">
            <div className="log-detail-section-head">
              <div>
                <span className="log-detail-kicker">请求</span>
                <h3>{entry.method} {entry.path}</h3>
              </div>
              <span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>
            </div>
            <div className="log-detail-section-grid">
              <div className="log-detail-item is-wide">
                <span className="log-detail-label">请求 ID</span>
                <span className="log-detail-value is-small">{entry.request_id}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">开始时间</span>
                <span className="log-detail-value is-medium">{formatDateTime(entry.time)}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">完成时间</span>
                <span className="log-detail-value is-medium">{formatDateTime(entry.completed_at)}</span>
              </div>
              <div className="log-detail-item is-full">
                <span className="log-detail-label">请求摘要</span>
                <span className="log-detail-value is-small">{entry.request_summary ?? "无"}</span>
              </div>
            </div>
          </section>

          <section className="log-detail-section" aria-label="路由与模型">
            <div className="log-detail-section-head">
              <div>
                <span className="log-detail-kicker">路由</span>
                <h3>{routeLabel(entry.route)}</h3>
              </div>
              <span className={`route-chip ${entry.route}`}>{entry.route}</span>
            </div>
            <div className="log-detail-section-grid">
              <div className="log-detail-item">
                <span className="log-detail-label">源模型</span>
                <span className="log-detail-value is-medium">{entry.source_model ?? "-"}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">目标模型</span>
                <span className="log-detail-value is-medium">{entry.target_model ?? entry.source_model ?? "-"}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">响应模型</span>
                <span className="log-detail-value is-medium">{entry.response_model ?? "-"}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">上游 Host</span>
                <span className="log-detail-value">{entry.upstream_host}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">端点</span>
                <span className="log-detail-value">{entry.endpoint}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">推理强度</span>
                <span className="log-detail-value is-small">{entry.reasoning_effort ?? "无"}</span>
              </div>
            </div>
          </section>

          <section className="log-detail-section" aria-label="性能">
            <div className="log-detail-section-head">
              <div>
                <span className="log-detail-kicker">性能</span>
                <h3>{formatDurationMs(entry.duration_ms)}</h3>
              </div>
              <span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span>
            </div>
            <div className="log-detail-section-grid">
              <div className="log-detail-item">
                <span className="log-detail-label">状态</span>
                <span className="log-detail-value">{entry.status}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">类型</span>
                <span className="log-detail-value">{entry.request_type}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">首 Token</span>
                <span className="log-detail-value">{formatDurationMs(entry.first_token_ms)}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">总耗时</span>
                <span className="log-detail-value">{formatDurationMs(entry.duration_ms)}</span>
              </div>
            </div>
          </section>

          <section className="log-detail-section is-wide" aria-label="Token 明细">
            <div className="log-detail-section-head">
              <div>
                <span className="log-detail-kicker">Token</span>
                <h3>{formatMetricNumber(displayTotalTokens(entry))}</h3>
              </div>
              <span className="token-total-pill">{formatCacheHitRate(entry)} 缓存命中</span>
            </div>
            <div className="log-detail-section-grid is-token-grid">
              <div className="log-detail-item">
                <span className="log-detail-label">输入</span>
                <span className="log-detail-value">{formatMetricNumber(displayInputTokens(entry))}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">输出</span>
                <span className="log-detail-value">{formatMetricNumber(entry.output_tokens)}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">{hasAdditiveCachedInput(entry) ? "缓存读取" : "缓存输入"}</span>
                <span className="log-detail-value">{formatMetricNumber(cacheReadInputTokens(entry))}</span>
              </div>
              {hasAdditiveCachedInput(entry) && (
                <div className="log-detail-item">
                  <span className="log-detail-label">缓存写入</span>
                  <span className="log-detail-value">{formatMetricNumber(cacheCreationInputTokens(entry))}</span>
                </div>
              )}
              {hasAdditiveCachedInput(entry) && (
                <div className="log-detail-item">
                  <span className="log-detail-label">缓存合计</span>
                  <span className="log-detail-value">{formatMetricNumber(cachedInputTotalTokens(entry))}</span>
                </div>
              )}
              <div className="log-detail-item">
                <span className="log-detail-label">总输入</span>
                <span className="log-detail-value">{formatMetricNumber(totalInputTokens(entry))}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">缓存输出</span>
                <span className="log-detail-value">{formatMetricNumber(entry.cached_output_tokens)}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">推理</span>
                <span className="log-detail-value">{formatMetricNumber(entry.reasoning_tokens)}</span>
              </div>
              <div className="log-detail-item">
                <span className="log-detail-label">原始总量</span>
                <span className="log-detail-value">{formatMetricNumber(entry.total_tokens)}</span>
              </div>
            </div>
          </section>

          <section className="log-detail-section is-wide" aria-label="诊断">
            <div className="log-detail-section-head">
              <div>
                <span className="log-detail-kicker">诊断</span>
                <h3>{entry.error_summary ? "错误信息" : "客户端信息"}</h3>
              </div>
            </div>
            <div className="log-detail-section-grid">
              <div className="log-detail-item is-full">
                <span className="log-detail-label">错误信息</span>
                <span className="log-detail-value">{entry.error_summary ?? "无"}</span>
              </div>
              <div className="log-detail-item is-full">
                <span className="log-detail-label">User Agent</span>
                <span className="log-detail-value is-tiny">{entry.user_agent ?? "-"}</span>
              </div>
              {entry.compact_response_normalized && (
                <div className="log-detail-item is-full">
                  <span className="log-detail-label">Compact 响应替换</span>
                  <span className="log-detail-value is-tiny">
                    {entry.compact_response_normalize_reason ?? "normalized"}
                    {" / "}
                    {entry.compact_response_synthetic_source ?? "unknown"}
                  </span>
                </div>
              )}
            </div>
          </section>

          <LogCaptureViewer entry={entry} />
        </div>
      </td>
    </tr>
  );
}
