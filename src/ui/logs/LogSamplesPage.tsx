import type { ComponentProps } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { LogsPage } from "./LogsPage.js";
import { LogSampleGroups } from "./LogSampleGroups.js";
import { ALL_HOSTS_FILTER } from "./log-utils.js";

type LogSamplesPageProps = Pick<ComponentProps<typeof LogsPage>,
  "logs" | "totalLogCount" | "hasMoreLogs" | "isLoadingLogs" | "isLoadingMoreLogs" |
  "hasStaleLogs" | "error" | "onRetryLogs" | "onLoadMore" | "drilldown" |
  "routeFilter" | "statusFilter" | "hostFilter" | "searchFilter"
> & { onBack: () => void };

export function LogSamplesPage({
  logs, totalLogCount, hasMoreLogs, isLoadingLogs, isLoadingMoreLogs, hasStaleLogs,
  error, onRetryLogs, onLoadMore, drilldown, routeFilter, statusFilter, hostFilter, searchFilter, onBack
}: LogSamplesPageProps) {
  const scope = [
    drilldown?.model !== undefined ? `响应模型：${drilldown.model ?? "未识别模型"}（精确）` : null,
    drilldown ? `开始时间：${new Date(drilldown.from).toLocaleString()} → ${new Date(drilldown.to).toLocaleString()}（本地时间，含起点、不含终点）` : null,
    routeFilter !== "all" ? routeLabel(routeFilter) : null,
    statusFilter !== "all" ? (statusFilter === "error" ? "错误" : "正常") : null,
    hostFilter !== ALL_HOSTS_FILTER ? `上游：${hostFilter}` : null,
    searchFilter ? `搜索：${searchFilter}` : null
  ].filter(Boolean).join(" · ");

  return <>
    <div className="page-header">
      <div>
        <p className="eyebrow">流量日志</p>
        <h2>样本概览</h2>
      </div>
      <button type="button" className="btn btn-sm" onClick={onBack}>返回请求日志</button>
    </div>
    <p className="log-sample-scope">{scope || "未限定筛选条件"}。与请求日志共用筛选，可返回调整。</p>

    {error && <div className="error-banner page-error-banner" role="alert">
      <span>{error}{hasStaleLogs && " 当前结果尚未更新，下面保留上次成功加载的结果。"}</span>
      <button type="button" className="btn btn-sm" disabled={isLoadingLogs} onClick={onRetryLogs}>
        {isLoadingLogs ? "重试中..." : "重试日志"}
      </button>
    </div>}

    {logs.length > 0 ? <LogSampleGroups logs={logs} stale={hasStaleLogs || isLoadingLogs} /> : (
      <div className="empty-state" role="status">
        <strong>{isLoadingLogs ? "正在加载样本..." : error ? "尚无可显示的样本" : "暂无请求样本"}</strong>
        {!isLoadingLogs && <span>{error ? "可重试加载，已选筛选条件会保留。" : "当前范围内没有已加载记录，可返回请求日志调整筛选。"}</span>}
      </div>
    )}

    {hasMoreLogs && <div className="log-load-more">
      <button type="button" className="btn" onClick={onLoadMore} disabled={hasStaleLogs || isLoadingLogs || isLoadingMoreLogs}>
        {isLoadingMoreLogs ? "加载中..." : `加载更早日志 (${logs.length}/${totalLogCount})`}
      </button>
    </div>}
  </>;
}
