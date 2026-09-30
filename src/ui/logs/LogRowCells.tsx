import { memo } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatDateTime, formatDurationMs } from "../shared/format.js";
import { LogModelSummary, LogTimingSummary, outputThroughputLabel } from "./LogSummary.js";
import { LogTextTooltip, TokenTooltip } from "./LogTooltips.js";
import {
  logStatusKind,
  logStatusToneClass,
  reasoningEffortLabel,
  responseModelDisplay,
  responseModelSourceLabel,
  hasResponseModelMismatch,
  compactionModeClass,
  compactionModeLabel
} from "./log-utils.js";

/**
 * The heavy part of a desktop log row — every tooltip cell. The motion row
 * frame around it changes on stagger ticks, but identical metadata skips cell
 * work both when a row shifts and when an HTTP snapshot recreates its object.
 */
export const LogRowCells = memo(function LogRowCells({
  entry,
  showAllColumns
}: {
  entry: RequestLogEntry;
  showAllColumns: boolean;
}) {
  const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
  const responseEvidence = hasResponseModelMismatch(entry) ? "响应声明不同" : responseModelSourceLabel(entry);
  const throughputHint = `${outputThroughputLabel(entry)} · 平均输出吞吐 = 输出 Token / 总耗时，包含等待时间，非纯生成速度。`;

  return (
    <>
      <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)}><time dateTime={entry.time}>{formatDateTime(entry.time)}</time></LogTextTooltip></td>
      <td><span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>
        {logStatusKind(entry) === "error" && <span className="visually-hidden"> 请求异常</span>}
      </td>
      <td>
        <LogTextTooltip className="log-model-cell" value={modelMapping}
          tooltip={`${modelMapping}\n响应模型：${responseModelDisplay(entry)} · ${responseModelSourceLabel(entry)}`}>
          <span className="log-model-route-badges">
            <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
            {entry.compaction_mode && <span className={`protocol-chip ${compactionModeClass(entry.compaction_mode)}`}>{compactionModeLabel(entry.compaction_mode)}</span>}
          </span>
          <LogModelSummary entry={entry} />
        </LogTextTooltip>
      </td>
      {showAllColumns && <>
        <td><LogTextTooltip className="log-cell-code" value={reasoningEffortLabel(entry)} /></td>
        <td><LogTextTooltip className="log-cell-code" value={responseModelDisplay(entry)}
          tooltip={`${responseModelDisplay(entry)} · ${responseModelSourceLabel(entry)}${hasResponseModelMismatch(entry) ? " · 响应声明不同（不代表模型鉴定）" : ""}`}>
          <span className="log-summary-stack"><span>{responseModelDisplay(entry)}</span>
            <small className={hasResponseModelMismatch(entry) ? "log-model-difference" : "log-evidence-label"}>{responseEvidence}</small>
          </span>
        </LogTextTooltip></td>
      </>}
      <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host}><span className="log-summary-stack"><span>{entry.upstream_host}</span>{!showAllColumns && entry.key_name && <small>上游凭据 · {entry.key_name}</small>}</span></LogTextTooltip></td>
      {showAllColumns && <>
        <td><LogTextTooltip className="log-cell-code" value={entry.key_name ?? "—"} /></td>
        <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
        <td><LogTextTooltip className="log-summary-stack" value={entry.request_type} tooltip={throughputHint}>
          <span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span>
          <small>{outputThroughputLabel(entry)}</small>
        </LogTextTooltip></td>
      </>}
      <td><TokenTooltip entry={entry} /></td>
      <td><LogTextTooltip className="log-cell-time" value="首响应是首个数据块，非首个生成 Token">
        {showAllColumns ? formatDurationMs(entry.first_token_ms) : <LogTimingSummary entry={entry} />}
      </LogTextTooltip></td>
      <td><LogTextTooltip className="log-cell-time"
        value={showAllColumns ? formatDurationMs(entry.duration_ms) : outputThroughputLabel(entry)}
        tooltip={showAllColumns ? "请求总耗时（包含等待时间）" : throughputHint} /></td>
    </>
  );
}, (previous, next) => previous.showAllColumns === next.showAllColumns && (previous.entry === next.entry ||
  // HTTP snapshots recreate metadata objects; equal data needs no cell render.
  JSON.stringify(previous.entry) === JSON.stringify(next.entry)));
