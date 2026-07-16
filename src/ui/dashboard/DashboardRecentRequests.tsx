import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { logStatusToneClass } from "../logs/log-utils.js";
import { LogTextTooltip } from "../logs/LogTooltips.js";
import { formatDateTime, formatDurationMs } from "../shared/format.js";

export function DashboardRecentRequests({
  logs,
  listen
}: {
  logs: RequestLogEntry[];
  listen: string;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <h3>最近请求</h3>
        <span className="status-pill">{logs.length} 条</span>
      </div>
      {logs.length === 0 ? (
        <div className="empty-state">
          <strong>暂无请求记录</strong>
          <span>将 Codex 的 base_url 设置为 http://{listen}/v1 即可看到实时流量。</span>
        </div>
      ) : (
        <>
        <div className="log-table log-table-summary dashboard-request-table">
          <div className="log-table-body" style={{ maxHeight: "300px" }}>
            <table className="log-table-grid">
              <colgroup>
                <col className="log-summary-col-started" />
                <col className="log-summary-col-completed" />
                <col className="log-summary-col-model" />
                <col className="log-summary-col-status" />
                <col className="log-summary-col-host" />
                <col className="log-summary-col-endpoint" />
                <col className="log-summary-col-route" />
                <col className="log-summary-col-type" />
                <col className="log-summary-col-duration" />
              </colgroup>
              <thead>
                <tr className="log-table-header">
                  <th scope="col">开始</th>
                  <th scope="col">完成</th>
                  <th scope="col">模型</th>
                  <th scope="col">状态</th>
                  <th scope="col">上游</th>
                  <th scope="col">端点</th>
                  <th scope="col">通道</th>
                  <th scope="col">类型</th>
                  <th scope="col">耗时</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 8).map((entry, i) => (
                  <tr key={`${entry.request_id}-${i}`} className="log-row">
                    <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)} /></td>
                    <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.completed_at)} /></td>
                    <td><LogTextTooltip className="log-cell-model" value={entry.source_model ?? "-"} /></td>
                    <td><span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span></td>
                    <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host} /></td>
                    <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
                    <td><span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span></td>
                    <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
                    <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.duration_ms)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="dashboard-request-list" aria-label="最近请求摘要">
          {logs.slice(0, 8).map((entry, i) => (
            <article className="dashboard-request-item" key={`${entry.request_id}-mobile-${i}`}>
              <div className="dashboard-request-item-head">
                <span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>
                <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
                <time>{formatDateTime(entry.time)}</time>
              </div>
              <strong>{entry.source_model ?? "-"}</strong>
              <code>{entry.upstream_host}</code>
              <span className="dashboard-request-duration">{formatDurationMs(entry.duration_ms)}</span>
            </article>
          ))}
          <a className="dashboard-request-all" href="/#logs">查看全部日志</a>
        </div>
        </>
      )}
    </div>
  );
}
