import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import { PROVIDER_LABELS, routeLabel } from "../../shared/route-meta.js";
import type {
  LogStatusKind,
  ProviderLogCounts,
  RequestLogEntry,
  RouteKind,
  StatusLogCounts
} from "../../shared/types.js";
import { CustomSelect } from "../shared/CustomSelect.js";
import { formatDateTime, formatDurationMs, formatMetricNumber } from "../shared/format.js";
import { LogTextTooltip, TokenTooltip } from "./LogTooltips.js";
import {
  ALL_HOSTS_FILTER,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  cachedInputTotalTokens,
  displayInputTokens,
  displayTotalTokens,
  formatCacheHitRate,
  hasAdditiveCachedInput,
  type HostFilterOption,
  modelReasoningLabel,
  totalInputTokens
} from "./log-utils.js";

const LOG_LAZY_LOAD_THRESHOLD_PX = 220;
const LOG_STICKY_TOP_THRESHOLD_PX = 24;

export function LogsPage({
  logs, logCounts, providerCounts, statusCounts, totalLogCount, allLogCount,
  hostOptions, hasMoreLogs, isLoadingLogs, isLoadingMoreLogs,
  routeFilter, statusFilter, hostFilter,
  onRouteFilterChange, onStatusFilterChange, onHostFilterChange, onLoadMore, error
}: {
  logs: RequestLogEntry[]; logCounts: Record<"all" | RouteKind, number>;
  providerCounts: ProviderLogCounts; statusCounts: StatusLogCounts;
  totalLogCount: number; allLogCount: number; hostOptions: HostFilterOption[];
  hasMoreLogs: boolean; isLoadingLogs: boolean; isLoadingMoreLogs: boolean;
  routeFilter: "all" | RouteKind; statusFilter: "all" | LogStatusKind; hostFilter: string;
  onRouteFilterChange: (route: "all" | RouteKind) => void;
  onStatusFilterChange: (status: "all" | LogStatusKind) => void;
  onHostFilterChange: (host: string) => void;
  onLoadMore: () => void; error: string | null;
}) {
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const tableBodyRef = useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = useRef({
    firstLogId: null as string | null,
    scrollHeight: 0,
    scrollTop: 0
  });
  const autoLoadPendingRef = useRef(false);

  useEffect(() => {
    if (!isLoadingMoreLogs) {
      autoLoadPendingRef.current = false;
    }
  }, [isLoadingMoreLogs, logs.length]);

  useLayoutEffect(() => {
    const body = tableBodyRef.current;
    if (!body) {
      return;
    }

    const previous = scrollSnapshotRef.current;
    const firstLogId = logs[0]?.request_id ?? null;
    const previousFirstIndex = previous.firstLogId
      ? logs.findIndex((entry) => entry.request_id === previous.firstLogId)
      : -1;
    const liveLogsWerePrepended = previousFirstIndex > 0 && firstLogId !== previous.firstLogId;

    if (liveLogsWerePrepended && previous.scrollTop > LOG_STICKY_TOP_THRESHOLD_PX) {
      const delta = body.scrollHeight - previous.scrollHeight;
      if (delta > 0) {
        body.scrollTop = previous.scrollTop + delta;
      }
    }

    scrollSnapshotRef.current = {
      firstLogId,
      scrollHeight: body.scrollHeight,
      scrollTop: body.scrollTop
    };
  }, [logs]);

  function handleLogScroll(event: UIEvent<HTMLDivElement>) {
    const body = event.currentTarget;
    scrollSnapshotRef.current = {
      ...scrollSnapshotRef.current,
      scrollHeight: body.scrollHeight,
      scrollTop: body.scrollTop
    };

    const remainingScroll = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (
      remainingScroll <= LOG_LAZY_LOAD_THRESHOLD_PX &&
      hasMoreLogs &&
      !isLoadingLogs &&
      !isLoadingMoreLogs &&
      !autoLoadPendingRef.current
    ) {
      autoLoadPendingRef.current = true;
      onLoadMore();
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">流量日志</p>
          <h2>请求日志</h2>
        </div>
        <span className="status-pill">
          显示 {logs.length} / 共 {totalLogCount} 条 · 已存储 {allLogCount} 条
        </span>
      </div>

      <div className="logs-toolbar">
        <CustomSelect
          label="通道"
          value={routeFilter}
          options={[
            { value: "all", label: "全部通道", count: logCounts.all },
            { value: "primary", label: "Codex 主路由", count: logCounts.primary, meta: "primary", tone: "codex" },
            { value: "compact", label: "Compact 压缩", count: logCounts.compact, meta: "compact", tone: "compact" },
            { value: "claude", label: "Claude 路由", count: logCounts.claude, meta: "claude", tone: "claude" }
          ]}
          onChange={(value) => onRouteFilterChange(value as "all" | RouteKind)}
        />
        <CustomSelect
          label="状态"
          value={statusFilter}
          options={[
            { value: "all", label: "全部", count: statusCounts.all },
            { value: "normal", label: "正常", count: statusCounts.normal, tone: "is-ok" },
            { value: "error", label: "错误", count: statusCounts.error, tone: "is-err" }
          ]}
          onChange={(value) => onStatusFilterChange(value as "all" | LogStatusKind)}
        />
        <CustomSelect
          label="上游 Host"
          value={hostFilter}
          options={[
            { value: ALL_HOSTS_FILTER, label: "全部上游", count: allLogCount },
            ...hostOptions.map((host) => ({ value: host.host, label: host.host, count: host.total }))
          ]}
          onChange={onHostFilterChange}
        />
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
          <span className="route-chip codex">{PROVIDER_LABELS.openai}: {providerCounts.openai}</span>
          <span className="route-chip claude">{PROVIDER_LABELS.claude}: {providerCounts.claude}</span>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {isLoadingLogs && logs.length === 0 ? (
        <div className="empty-state"><strong>正在加载日志...</strong></div>
      ) : logs.length === 0 ? (
        <div className="empty-state">
          <strong>暂无请求记录</strong>
          <span>将 Codex base_url 指向代理地址后，这里会实时出现路由记录。</span>
        </div>
      ) : (
        <div className="log-table log-table-full">
          <div
            ref={tableBodyRef}
            className="log-table-body"
            onScroll={handleLogScroll}
            aria-busy={isLoadingLogs || isLoadingMoreLogs}
          >
            <table className="log-table-grid">
              <thead>
                <tr className="log-table-header">
                  <th scope="col">时间</th>
                  <th scope="col">模型 / 通道</th>
                  <th scope="col">状态</th>
                  <th scope="col">模型 / 思考</th>
                  <th scope="col">上游 Host</th>
                  <th scope="col">端点</th>
                  <th scope="col">类型</th>
                  <th scope="col">Token</th>
                  <th scope="col">首 Token</th>
                  <th scope="col">耗时</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => {
                  const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
                  const hasRewrite = Boolean(entry.source_model && entry.target_model && entry.source_model !== entry.target_model);
                  const hasError = Boolean(entry.error_summary) || entry.status >= 400;
                  return (
                    <Fragment key={entry.request_id}>
                      <tr
                        className={`log-row is-clickable ${hasError ? "has-error" : ""}`}
                        onClick={() =>
                          setExpandedRequestId((currentId) => currentId === entry.request_id ? null : entry.request_id)
                        }
                      >
                        <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)} /></td>
                        <td>
                          <LogTextTooltip className="log-model-cell" value={modelMapping}>
                            <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
                            <strong>{entry.source_model ?? "-"}</strong>
                            {hasRewrite && <small>→ {entry.target_model}</small>}
                          </LogTextTooltip>
                        </td>
                        <td><span className={`log-status ${entry.status < 400 ? "is-ok" : "is-err"}`}>{entry.status}</span></td>
                        <td><LogTextTooltip className="log-cell-code" value={modelReasoningLabel(entry)} /></td>
                        <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host} /></td>
                        <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
                        <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
                        <td><TokenTooltip entry={entry} /></td>
                        <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.first_token_ms)} /></td>
                        <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.duration_ms)} /></td>
                      </tr>
                      {expandedRequestId === entry.request_id && (
                        <tr className="log-detail-row">
                          <td colSpan={10}>
                            <div className="log-detail-panel">
                              <section className="log-detail-section is-primary" aria-label="请求上下文">
                                <div className="log-detail-section-head">
                                  <div>
                                    <span className="log-detail-kicker">请求</span>
                                    <h3>{entry.method} {entry.path}</h3>
                                  </div>
                                  <span className={`log-status ${entry.status < 400 ? "is-ok" : "is-err"}`}>{entry.status}</span>
                                </div>
                                <div className="log-detail-section-grid">
                                  <div className="log-detail-item is-wide">
                                    <span className="log-detail-label">请求 ID</span>
                                    <span className="log-detail-value is-small">{entry.request_id}</span>
                                  </div>
                                  <div className="log-detail-item">
                                    <span className="log-detail-label">采样时间</span>
                                    <span className="log-detail-value is-medium">{entry.time}</span>
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
                                </div>
                              </section>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hasMoreLogs && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button className="btn" onClick={onLoadMore} disabled={isLoadingMoreLogs}>
            {isLoadingMoreLogs ? "加载中..." : `加载更早日志 (${logs.length}/${totalLogCount})`}
          </button>
        </div>
      )}
    </>
  );
}
