import { Fragment, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PROVIDER_LABELS, routeLabel } from "../../shared/route-meta.js";
import type {
  LogStatusKind,
  ProviderLogCounts,
  RequestLogEntry,
  RouteKind,
  StatusLogCounts
} from "../../shared/types.js";
import { CustomSelect } from "../shared/CustomSelect.js";
import { formatDateTime, formatDurationMs } from "../shared/format.js";
import { LogDetailRow } from "./LogDetailRow.js";
import { LogTextTooltip, TokenTooltip } from "./LogTooltips.js";
import {
  ALL_HOSTS_FILTER,
  type HostFilterOption,
  logStatusToneClass,
  modelReasoningLabel
} from "./log-utils.js";
import { useLogTableScroll } from "./useLogTableScroll.js";
import { useStaggeredLogs } from "./useStaggeredLogs.js";

const MotionTr = motion.tr;

const rowTransition = {
  type: "spring" as const,
  stiffness: 500,
  damping: 30,
  mass: 1,
  opacity: { duration: 0.15 },
};

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
  const displayedLogs = useStaggeredLogs(logs);
  const { handleLogScroll, tableBodyRef } = useLogTableScroll({
    hasMoreLogs,
    isLoadingLogs,
    isLoadingMoreLogs,
    logs: displayedLogs,
    onLoadMore
  });

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">流量日志</p>
          <h2>请求日志</h2>
        </div>
        <span className="status-pill">
          显示 {displayedLogs.length} / 共 {totalLogCount} 条 · 已存储 {allLogCount} 条
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

      {isLoadingLogs && displayedLogs.length === 0 ? (
        <div className="empty-state"><strong>正在加载日志...</strong></div>
      ) : displayedLogs.length === 0 ? (
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
              <colgroup>
                <col className="log-col-started" />
                <col className="log-col-completed" />
                <col className="log-col-model-route" />
                <col className="log-col-status" />
                <col className="log-col-reasoning" />
                <col className="log-col-host" />
                <col className="log-col-endpoint" />
                <col className="log-col-type" />
                <col className="log-col-token" />
                <col className="log-col-first-token" />
                <col className="log-col-duration" />
              </colgroup>
              <thead>
                <tr className="log-table-header">
                  <th scope="col">开始时间</th>
                  <th scope="col">完成时间</th>
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
                <AnimatePresence initial={false} mode="popLayout">
                  {displayedLogs.map((entry) => {
                    const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
                    const hasRewrite = Boolean(entry.source_model && entry.target_model && entry.source_model !== entry.target_model);
                    const hasError = Boolean(entry.error_summary) || entry.status >= 400;
                    return (
                      <Fragment key={entry.request_id}>
                        <MotionTr
                          initial={{ opacity: 0, y: -16 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={rowTransition}
                          layout
                          className={`log-row is-clickable ${hasError ? "has-error" : ""}`}
                          onClick={() =>
                            setExpandedRequestId((currentId) => currentId === entry.request_id ? null : entry.request_id)
                          }
                        >
                          <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)} /></td>
                          <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.completed_at)} /></td>
                          <td>
                            <LogTextTooltip className="log-model-cell" value={modelMapping}>
                              <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
                              <strong>{entry.source_model ?? "-"}</strong>
                              {hasRewrite && <small>→ {entry.target_model}</small>}
                            </LogTextTooltip>
                          </td>
                          <td><span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span></td>
                          <td><LogTextTooltip className="log-cell-code" value={modelReasoningLabel(entry)} /></td>
                          <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host} /></td>
                          <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
                          <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
                          <td><TokenTooltip entry={entry} /></td>
                          <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.first_token_ms)} /></td>
                          <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.duration_ms)} /></td>
                        </MotionTr>
                        {expandedRequestId === entry.request_id && <LogDetailRow entry={entry} />}
                      </Fragment>
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hasMoreLogs && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button className="btn" onClick={onLoadMore} disabled={isLoadingMoreLogs}>
            {isLoadingMoreLogs ? "加载中..." : `加载更早日志 (${displayedLogs.length}/${totalLogCount})`}
          </button>
        </div>
      )}
    </>
  );
}
