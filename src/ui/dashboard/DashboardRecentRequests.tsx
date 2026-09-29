import { useId, useMemo, useState } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { logStatusToneClass } from "../logs/log-utils.js";
import { useNarrowViewport } from "../logs/useNarrowViewport.js";
import { LogTextTooltip } from "../logs/LogTooltips.js";
import { formatDateTime, formatDurationMs } from "../shared/format.js";

/** Both layouts show the same eight rows; the fourth is where the fold lands. */
const DASHBOARD_REQUEST_LIMIT = 8;

export function DashboardRecentRequests({
  logs,
  listen
}: {
  logs: RequestLogEntry[];
  listen: string;
}) {
  const narrowViewport = useNarrowViewport("(max-width: 760px)");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const keyboardHintId = useId();
  const toggleRow = (id: string) => setExpandedId((current) => current === id ? null : id);
  // One slice and one pass of formatting for both layouts. The table and the
  // card list are alternatives, never shown together, so rendering only the
  // visible one skips half this component's work on every log event — and stops
  // mounting eight hidden <article>s on desktop.
  const recent = useMemo(() => logs.slice(0, DASHBOARD_REQUEST_LIMIT), [logs]);
  const rows = useMemo(() => recent.map((entry) => ({
    entry,
    startedAt: formatDateTime(entry.time),
    completedAt: formatDateTime(entry.completed_at),
    duration: formatDurationMs(entry.duration_ms)
  })), [recent]);
  const expandedRow = rows.find(({ entry }) => entry.request_id === expandedId);
  const detailId = `${keyboardHintId}-detail`;
  const closeDetails = () => {
    setExpandedId(null);
    document.getElementById(`${keyboardHintId}-trigger-${expandedId}`)?.focus();
  };
  const detail = expandedRow && (
    <dl key={expandedRow.entry.request_id} className="dashboard-request-detail" id={detailId} aria-label="最近请求完整信息"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeDetails(); } }}>
      <div className="is-wide dashboard-request-detail-heading">
        <dt>请求 ID</dt>
        <dd><code>{expandedRow.entry.request_id}</code><button type="button" className="btn btn-sm btn-ghost"
          aria-label="收起请求详情" onClick={closeDetails}>收起详情</button></dd>
      </div>
      {[
        ["开始时间", expandedRow.startedAt],
        ["完成时间", expandedRow.completedAt],
        ["耗时", expandedRow.duration],
        ["状态", String(expandedRow.entry.status)],
        ["通道", routeLabel(expandedRow.entry.route)],
        ["类型", expandedRow.entry.request_type],
        ["模型", expandedRow.entry.source_model ?? "-"],
        ["上游 Host", expandedRow.entry.upstream_host],
        ["端点", expandedRow.entry.endpoint]
      ].map(([label, value], index) => (
        <div key={label} className={index >= 6 ? "is-wide" : undefined}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div className="card">
      <div className="card-header">
        <h3>最近请求</h3>
        {!narrowViewport && <span className="log-keyboard-hint" id={keyboardHintId}>点击请求行，或聚焦后按 Enter / 空格查看完整信息</span>}
        <a className="dashboard-health-summary-link" href="/#logs">查看全部日志 · {logs.length} 条</a>
      </div>
      {logs.length === 0 ? (
        <div className="empty-state">
          <strong>暂无请求记录</strong>
          <span>将 Codex 的 base_url 设置为 http://{listen}/v1 即可看到实时流量。</span>
        </div>
      ) : narrowViewport ? (
        <div className="dashboard-request-list" aria-label="最近请求摘要">
          {rows.map(({ entry, startedAt, duration }) => (
            <article key={entry.request_id}>
              <button type="button" className="dashboard-request-item"
                id={`${keyboardHintId}-trigger-${entry.request_id}`}
                aria-expanded={expandedId === entry.request_id}
                aria-controls={expandedId === entry.request_id ? detailId : undefined}
                onClick={() => toggleRow(entry.request_id)}
                onKeyDown={(event) => { if (event.key === "Escape") setExpandedId(null); }}>
              <span className="dashboard-request-item-head">
                <span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>
                <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
                <time>{startedAt}</time>
              </span>
              <strong>{entry.source_model ?? "-"}</strong>
              <code>{entry.upstream_host}</code>
              <span className="dashboard-request-duration">{duration}</span>
              <span className="dashboard-request-disclosure">{expandedId === entry.request_id ? "收起详情" : "查看详情"}</span>
              </button>
              {expandedId === entry.request_id && detail}
            </article>
          ))}
        </div>
      ) : (
        <div className="log-table log-table-summary dashboard-request-table">
          <div className="log-table-body log-table-body-summary">
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
                <tr>
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
                {rows.map(({ entry, startedAt, completedAt, duration }) => (
                  <tr
                    key={entry.request_id}
                    className={`log-row is-clickable ${expandedId === entry.request_id ? "is-expanded" : ""}`}
                    id={`${keyboardHintId}-trigger-${entry.request_id}`}
                    tabIndex={0}
                    aria-expanded={expandedId === entry.request_id}
                    aria-describedby={keyboardHintId}
                    aria-controls={expandedId === entry.request_id ? detailId : undefined}
                    aria-label={`${entry.status} ${entry.source_model ?? "未知模型"}，${expandedId === entry.request_id ? "收起" : "查看"}完整信息`}
                    onClick={() => toggleRow(entry.request_id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleRow(entry.request_id);
                      } else if (event.key === "Escape") {
                        setExpandedId(null);
                      }
                    }}
                  >
                    <td><LogTextTooltip className="log-cell-time" value={startedAt} /></td>
                    <td><LogTextTooltip className="log-cell-time" value={completedAt} /></td>
                    <td><LogTextTooltip className="log-cell-model" value={entry.source_model ?? "-"} /></td>
                    <td><span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span></td>
                    <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host} /></td>
                    <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
                    <td><span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span></td>
                    <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
                    <td><LogTextTooltip className="log-cell-time" value={duration} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail}
        </div>
      )}
    </div>
  );
}
