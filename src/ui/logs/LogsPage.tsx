import { useCallback, useState } from "react";
import type { KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { PROVIDER_LABELS, routeLabel } from "../../shared/route-meta.js";
import type {
  LogStatusKind,
  ProviderLogCounts,
  RequestLogEntry,
  RouteKind,
  StatusLogCounts
} from "../../shared/types.js";
import { CustomSelect } from "../shared/CustomSelect.js";
import { LogDetailPanel } from "./LogDetailRow.js";
import { LogMobileCard } from "./LogMobileCard.js";
import { LogRowCells } from "./LogRowCells.js";
import {
  ALL_HOSTS_FILTER,
  type HostFilterOption,
  logStatusKind
} from "./log-utils.js";
import { useLogTableScroll } from "./useLogTableScroll.js";

function logEntryKey(entry: RequestLogEntry): string {
  return `${entry.request_id}-${entry.time}`;
}
const MotionDiv = motion.div;
const MotionSpan = motion.span;
const MotionTr = motion.tr;
// Desktop and mobile rows use the same tween for consistency and lower CPU cost.
// A spring's organic bounce isn't needed for data table rows.
const rowTransition = {
  duration: 0.15,
  ease: [0.2, 1, 0.3, 1] as const,
  opacity: { duration: 0.12 }
};

const detailTransition = {
  duration: 0.2,
  ease: [0.16, 1, 0.3, 1] as const
};

// Module-level so the prop identity is stable across renders — a fresh object
// every tick would defeat memoization of the row components below.
const REDUCED_MOTION_TRANSITION = { duration: 0.01 };

export function LogsPage({
  logs, pendingLogCount = 0,
  logCounts, providerCounts, statusCounts, totalLogCount, allLogCount,
  hostOptions, hasMoreLogs, isLoadingLogs, isLoadingMoreLogs,
  routeFilter, statusFilter, hostFilter, searchFilter,
  onRouteFilterChange, onStatusFilterChange, onHostFilterChange, onSearchFilterChange, onLoadMore, error
}: {
  logs: RequestLogEntry[];
  pendingLogCount?: number;
  logCounts: Record<"all" | RouteKind, number>;
  providerCounts: ProviderLogCounts; statusCounts: StatusLogCounts;
  totalLogCount: number; allLogCount: number; hostOptions: HostFilterOption[];
  hasMoreLogs: boolean; isLoadingLogs: boolean; isLoadingMoreLogs: boolean;
  routeFilter: "all" | RouteKind; statusFilter: "all" | LogStatusKind; hostFilter: string; searchFilter: string;
  onRouteFilterChange: (route: "all" | RouteKind) => void;
  onStatusFilterChange: (status: "all" | LogStatusKind) => void;
  onHostFilterChange: (host: string) => void;
  onSearchFilterChange: (search: string) => void;
  onLoadMore: () => void; error: string | null;
}) {
  const [expandedLogKey, setExpandedLogKey] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();
  const effectiveRowTransition = reduceMotion ? REDUCED_MOTION_TRANSITION : rowTransition;
  const {
    handleLogScroll,
    handleMobileLogScroll,
    mobileListRef,
    scrollToLatest,
    tableBodyRef,
    unseenLogCount
  } = useLogTableScroll({
    hasMoreLogs,
    isLoadingLogs,
    isLoadingMoreLogs,
    logs,
    onLoadMore
  });
  const hasActiveFilters = routeFilter !== "all" || statusFilter !== "all" || hostFilter !== ALL_HOSTS_FILTER || searchFilter.trim().length > 0;

  // useCallback not for this function's own sake: LogMobileCard is memoized, so
  // a fresh onToggle identity on every render would defeat the memo and rerender
  // every collapsed card at each 150ms stagger tick. Only refs and the stable
  // setState are read here, so the empty deps are exact.
  const toggleLog = useCallback((logKey: string) => {
    // 记录移动列表当前滚动位置,展开详情后恢复,避免内容下推导致视口跑掉。
    const previousScrollTop = mobileListRef.current?.scrollTop ?? null;
    setExpandedLogKey((currentKey) => currentKey === logKey ? null : logKey);
    if (previousScrollTop !== null) {
      window.requestAnimationFrame(() => {
        const list = mobileListRef.current;
        if (list) {
          list.scrollTop = previousScrollTop;
        }
      });
    }
  }, []);

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
    onSearchFilterChange("");
  }

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">流量日志</p>
          <h2>请求日志</h2>
        </div>
        <div className="logs-page-actions">
          {/* The live region stays mounted and only its contents change: an
              aria-live element that enters the DOM already holding its text is
              normally not announced at all. */}
          <span className="logs-new-entries-live" aria-live="polite">
            <AnimatePresence initial={false}>
              {unseenLogCount > 0 && (
                <MotionSpan
                  className="logs-new-entries-motion"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={detailTransition}
                >
                  <button className="btn btn-sm logs-new-entries" type="button" onClick={scrollToLatest}>
                    新增 {unseenLogCount} 条 · 回到最新
                  </button>
                </MotionSpan>
              )}
            </AnimatePresence>
          </span>
          {/* Only a live burst can queue rows now (snapshot syncs and resumes
              replace outright), so the queue tops out at INSTANT_THRESHOLD and
              this is a short-lived hint at 4+ rows — roughly half a second. */}
          <AnimatePresence initial={false}>
            {pendingLogCount > 3 && (
              <MotionSpan
                className="logs-queue-indicator"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={detailTransition}
              >
                <span className="logs-queue-dot" aria-hidden="true" />
                {pendingLogCount} 条待显示
              </MotionSpan>
            )}
          </AnimatePresence>
          <span className="status-pill">
            显示 {logs.length} / 共 {totalLogCount} 条 · 已存储 {allLogCount} 条
          </span>
        </div>
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
            { value: "normal", label: "正常", count: statusCounts.normal, tone: "ok" },
            { value: "error", label: "错误", count: statusCounts.error, tone: "err" }
          ]}
          onChange={(value) => onStatusFilterChange(value as "all" | LogStatusKind)}
        />
        <CustomSelect
          label="上游 Host"
          value={hostFilter}
          options={[
            // The host rows come from the filtered host facet, so the "all"
            // entry has to be their sum. allLogCount is the whole-database
            // count and belongs in the stored-rows line, not here.
            { value: ALL_HOSTS_FILTER, label: "全部上游", count: hostOptions.reduce((total, host) => total + host.total, 0) },
            ...hostOptions.map((host) => ({ value: host.host, label: host.host, count: host.total }))
          ]}
          onChange={onHostFilterChange}
          wide
        />
        <label className="logs-search">
          <span className="logs-search-label">搜索</span>
          <input
            className="logs-search-input"
            type="search"
            value={searchFilter}
            placeholder="模型名 / 请求 ID / 端点"
            aria-label="搜索日志"
            onChange={(event) => onSearchFilterChange(event.target.value)}
          />
        </label>
        <div className="log-error-filter-field">
          <span className="log-error-filter-label" aria-hidden="true" />
          <button
            className={`log-error-filter ${statusFilter === "error" ? "is-active" : ""}`}
            type="button"
            aria-pressed={statusFilter === "error"}
            onClick={() => onStatusFilterChange(statusFilter === "error" ? "all" : "error")}
          >
            <span className="log-error-filter-dot" aria-hidden="true" />
            {statusFilter === "error" ? "全部状态" : "只看错误"}
          </button>
        </div>
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
        hasActiveFilters ? (
          <div className="empty-state">
            <strong>当前筛选条件下无记录</strong>
            <span>没有请求匹配当前通道 / 状态 / 上游筛选。</span>
            <button className="btn empty-state-action" type="button" onClick={clearFilters}>
              清除筛选
            </button>
          </div>
        ) : (
          <div className="empty-state">
            <strong>暂无请求记录</strong>
            <span>将 Codex base_url 指向代理地址后，这里会实时出现路由记录。</span>
          </div>
        )
      ) : null}

      <div className="log-table log-table-full" hidden={logs.length === 0}>
          <div
            ref={tableBodyRef}
            className="log-table-body"
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
                <col className="log-col-key" />
                <col className="log-col-endpoint" />
                <col className="log-col-type" />
                <col className="log-col-token" />
                <col className="log-col-first-token" />
                <col className="log-col-duration" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">开始时间</th>
                  <th scope="col">状态</th>
                  <th scope="col">模型 / 通道</th>
                  <th scope="col">思考</th>
                  <th scope="col">响应模型</th>
                  <th scope="col">上游 Host</th>
                  <th scope="col">密钥</th>
                  <th scope="col">端点</th>
                  <th scope="col">类型</th>
                  <th scope="col">Token</th>
                  <th scope="col">首 Token</th>
                  <th scope="col">耗时</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {logs.flatMap((entry) => {
                    const logKey = logEntryKey(entry);
                    const detailId = `desktop-log-detail-${entry.request_id}`;
                    const expanded = expandedLogKey === logKey;
                    const hasError = logStatusKind(entry) === "error";
                    const rows = [
                      <MotionTr
                        key={logKey}
                        initial={{ opacity: 0, y: -20, height: 0 }}
                        animate={{ opacity: 1, y: 0, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={effectiveRowTransition}
                        data-log-id={entry.request_id}
                        className={`log-row is-clickable ${hasError ? "has-error" : ""}`}
                        tabIndex={0}
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        aria-label={`${entry.status} ${routeLabel(entry.route)} ${entry.source_model ?? "未知模型"}，${expanded ? "收起详情" : "展开详情"}`}
                        onClick={() => toggleLog(logKey)}
                        onKeyDown={(event) => handleRowKeyDown(event, logKey)}
                      >
                        <LogRowCells entry={entry} />
                      </MotionTr>
                    ];

                    if (expanded) {
                      rows.push(
                        <MotionTr
                          key={`${logKey}-detail`}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={reduceMotion ? REDUCED_MOTION_TRANSITION : detailTransition}
                          className="log-detail-row"
                          id={detailId}
                        >
                          <td colSpan={12}>
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
          </div>
      </div>

      {/* Rendered conditionally rather than with `hidden`: the narrow-screen rule
          sets `display: grid`, which outranks the UA rule for [hidden]. */}
      {logs.length > 0 && (
        <div
          ref={mobileListRef}
          className="logs-mobile-list"
          aria-label="请求日志摘要"
          onScroll={handleMobileLogScroll}
        >
          <AnimatePresence initial={false}>
            {logs.map((entry) => {
              const logKey = logEntryKey(entry);
              return (
                <MotionDiv
                  key={`mobile-${logKey}`}
                  className="log-mobile-motion-item"
                  initial={{ opacity: 0, y: -20, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={effectiveRowTransition}
                  data-log-id={entry.request_id}
                >
                  <LogMobileCard
                    entry={entry}
                    logKey={logKey}
                    detailId={`mobile-log-detail-${entry.request_id}`}
                    expanded={expandedLogKey === logKey}
                    onToggle={toggleLog}
                  />
                </MotionDiv>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {hasMoreLogs && (
        <div className="log-load-more">
          <button className="btn" onClick={onLoadMore} disabled={isLoadingLogs || isLoadingMoreLogs}>
            {isLoadingMoreLogs ? "加载中..." : `加载更早日志 (${logs.length}/${totalLogCount})`}
          </button>
        </div>
      )}
    </>
  );
}
