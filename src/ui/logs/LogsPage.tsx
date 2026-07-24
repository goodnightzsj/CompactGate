import { useState } from "react";
import type { KeyboardEvent } from "react";
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
import { LogDetailPanel } from "./LogDetailRow.js";
import { LogMobileCard } from "./LogMobileCard.js";
import { LogTextTooltip, TokenTooltip } from "./LogTooltips.js";
import {
  ALL_HOSTS_FILTER,
  logStatusKind,
  type HostFilterOption,
  logStatusToneClass,
  reasoningEffortLabel,
  responseModelDisplay,
  compactionModeClass,
  compactionModeLabel
} from "./log-utils.js";
import { useLogTableScroll } from "./useLogTableScroll.js";

const MotionDiv = motion.div;
const MotionSpan = motion.span;
const MotionTr = motion.tr;

const logRowTransition = {
  type: "spring" as const,
  stiffness: 460,
  damping: 34,
  mass: 0.72,
  opacity: { duration: 0.14 }
};

const detailTransition = {
  duration: 0.2,
  ease: [0.16, 1, 0.3, 1] as const
};

function logEntryKey(entry: RequestLogEntry): string {
  return `${entry.request_id}-${entry.time}`;
}

export function LogsPage({
  logs,
  logCounts, providerCounts, statusCounts, totalLogCount, allLogCount,
  hostOptions, hasMoreLogs, isLoadingLogs, isLoadingMoreLogs,
  routeFilter, statusFilter, hostFilter,
  onRouteFilterChange, onStatusFilterChange, onHostFilterChange, onLoadMore, error
}: {
  logs: RequestLogEntry[];
  logCounts: Record<"all" | RouteKind, number>;
  providerCounts: ProviderLogCounts; statusCounts: StatusLogCounts;
  totalLogCount: number; allLogCount: number; hostOptions: HostFilterOption[];
  hasMoreLogs: boolean; isLoadingLogs: boolean; isLoadingMoreLogs: boolean;
  routeFilter: "all" | RouteKind; statusFilter: "all" | LogStatusKind; hostFilter: string;
  onRouteFilterChange: (route: "all" | RouteKind) => void;
  onStatusFilterChange: (status: "all" | LogStatusKind) => void;
  onHostFilterChange: (host: string) => void;
  onLoadMore: () => void; error: string | null;
}) {
  const [expandedLogKey, setExpandedLogKey] = useState<string | null>(null);
  const { handleLogScroll, tableBodyRef } = useLogTableScroll({
    hasMoreLogs,
    isLoadingLogs,
    isLoadingMoreLogs,
    logs,
    onLoadMore
  });
  const hasActiveFilters = routeFilter !== "all" || statusFilter !== "all" || hostFilter !== ALL_HOSTS_FILTER;

  function toggleLog(logKey: string) {
    setExpandedLogKey((currentKey) => currentKey === logKey ? null : logKey);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, logKey: string) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    toggleLog(logKey);
  }

  function clearFilters() {
    onRouteFilterChange("all");
    onStatusFilterChange("all");
    onHostFilterChange(ALL_HOSTS_FILTER);
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
        <AnimatePresence initial={false}>
          {hasActiveFilters && (
            <MotionSpan
              className="logs-clear-filters-motion"
              initial={{ opacity: 0, scale: 0.96, x: -4 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.98, x: -3 }}
              transition={detailTransition}
            >
              <button className="btn btn-sm logs-clear-filters" type="button" onClick={clearFilters}>
                清除筛选
              </button>
            </MotionSpan>
          )}
        </AnimatePresence>
        <div className="logs-provider-counts">
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
          <MotionDiv
            ref={tableBodyRef}
            className="log-table-body"
            layoutScroll
            onScroll={handleLogScroll}
            aria-busy={isLoadingLogs || isLoadingMoreLogs}
          >
            <table className="log-table-grid">
              <colgroup>
                <col className="log-col-started" />
                <col className="log-col-status" />
                <col className="log-col-model-route" />
                <col className="log-col-reasoning" />
                <col className="log-col-response-model" />
                <col className="log-col-host" />
                <col className="log-col-type" />
                <col className="log-col-token" />
                <col className="log-col-first-token" />
                <col className="log-col-duration" />
              </colgroup>
              <thead>
                <tr className="log-table-header">
                  <th scope="col">开始时间</th>
                  <th scope="col">状态</th>
                  <th scope="col">模型 / 通道</th>
                  <th scope="col">思考</th>
                  <th scope="col">响应模型</th>
                  <th scope="col">上游 Host</th>
                  <th scope="col">类型</th>
                  <th scope="col">Token</th>
                  <th scope="col">首 Token</th>
                  <th scope="col">耗时</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false} mode="popLayout">
                  {logs.flatMap((entry, index) => {
                    const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
                    const hasRewrite = Boolean(entry.source_model && entry.target_model && entry.source_model !== entry.target_model);
                    const hasError = logStatusKind(entry) === "error";
                    const logKey = logEntryKey(entry);
                    const detailId = `desktop-log-detail-${index}`;
                    const expanded = expandedLogKey === logKey;
                    const rows = [
                      <MotionTr
                        key={logKey}
                        layout="position"
                        initial={{ opacity: 0, y: -14, scale: 0.995 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={logRowTransition}
                        className={`log-row is-clickable ${hasError ? "has-error" : ""}`}
                        tabIndex={0}
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        aria-label={`${entry.status} ${routeLabel(entry.route)} ${entry.source_model ?? "未知模型"}，${expanded ? "收起详情" : "展开详情"}`}
                        onClick={() => toggleLog(logKey)}
                        onKeyDown={(event) => handleRowKeyDown(event, logKey)}
                      >
                        <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)} /></td>
                        <td><span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span></td>
                        <td>
                          <LogTextTooltip className="log-model-cell" value={modelMapping}>
                            <span className="log-model-route-badges">
                              <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
                              {entry.compaction_mode && <span className={`protocol-chip ${compactionModeClass(entry.compaction_mode)}`}>{compactionModeLabel(entry.compaction_mode)}</span>}
                            </span>
                            <strong>{entry.source_model ?? "-"}</strong>
                            {hasRewrite && <small>→ {entry.target_model}</small>}
                          </LogTextTooltip>
                        </td>
                        <td><LogTextTooltip className="log-cell-code" value={reasoningEffortLabel(entry)} /></td>
                        <td><LogTextTooltip className="log-cell-code" value={responseModelDisplay(entry)} /></td>
                        <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host} /></td>
                        <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
                        <td><TokenTooltip entry={entry} /></td>
                        <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.first_token_ms)} /></td>
                        <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.duration_ms)} /></td>
                      </MotionTr>
                    ];

                    if (expanded) {
                      rows.push(
                        <MotionTr
                          key={`${logKey}-detail`}
                          layout="position"
                          initial={{ opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={detailTransition}
                          className="log-detail-row"
                          id={detailId}
                        >
                          <td colSpan={10}>
                            <LogDetailPanel entry={entry} />
                          </td>
                        </MotionTr>
                      );
                    }

                    return rows;
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          </MotionDiv>
        </div>
      )}

      {logs.length > 0 && (
        <MotionDiv className="logs-mobile-list" aria-label="请求日志摘要" layoutScroll>
          <AnimatePresence initial={false} mode="popLayout">
            {logs.map((entry, index) => {
              const logKey = logEntryKey(entry);
              return (
                <MotionDiv
                  key={`mobile-${logKey}`}
                  className="log-mobile-motion-item"
                  layout="position"
                  initial={{ opacity: 0, y: -10, scale: 0.995 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -5 }}
                  transition={logRowTransition}
                >
                  <LogMobileCard
                    entry={entry}
                    detailId={`mobile-log-detail-${index}`}
                    expanded={expandedLogKey === logKey}
                    onToggle={() => toggleLog(logKey)}
                  />
                </MotionDiv>
              );
            })}
          </AnimatePresence>
        </MotionDiv>
      )}

      {hasMoreLogs && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button className="btn" onClick={onLoadMore} disabled={isLoadingLogs || isLoadingMoreLogs}>
            {isLoadingMoreLogs ? "加载中..." : `加载更早日志 (${logs.length}/${totalLogCount})`}
          </button>
        </div>
      )}
    </>
  );
}
