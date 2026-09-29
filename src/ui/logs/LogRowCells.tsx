import { memo } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatDateTime } from "../shared/format.js";
import { LogModelSummary, LogTimingSummary, outputThroughputLabel } from "./LogSummary.js";
import { LogTextTooltip, TokenTooltip } from "./LogTooltips.js";
import {
  logStatusToneClass,
  reasoningEffortLabel,
  responseModelDisplay,
  responseModelSourceLabel,
  logStatusKind,
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
  const dateTime = formatDateTime(entry.time).split(" ");

  return (
    <>
      <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)}><time className="log-summary-stack" dateTime={entry.time}><small>{dateTime[0]}</small><span>{dateTime.slice(1).join(" ")}</span></time></LogTextTooltip></td>
      <td><span className="log-summary-stack"><span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>{logStatusKind(entry) === "error" && <small className="log-error-hint" title={entry.error_summary ?? entry.stream_outcome ?? "请求未成功"}>失败 · 详情</small>}</span></td>
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
        <td><LogTextTooltip className="log-cell-code" value={responseModelDisplay(entry)}><span className="log-summary-stack"><span>{responseModelDisplay(entry)}</span><small>{responseModelSourceLabel(entry)}</small></span></LogTextTooltip></td>
      </>}
      <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host}><span className="log-summary-stack"><span>{entry.upstream_host}</span>{!showAllColumns && entry.key_name && <small>上游凭据 · {entry.key_name}</small>}</span></LogTextTooltip></td>
      {showAllColumns && <>
        <td><LogTextTooltip className="log-cell-code" value={entry.key_name ?? "—"} /></td>
        <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
        <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
      </>}
      <td><TokenTooltip entry={entry} /></td>
      <td><LogTextTooltip className="log-cell-time" value="首响应是首个数据块，非首个生成 Token"><LogTimingSummary entry={entry} /></LogTextTooltip></td>
      <td><LogTextTooltip className="log-cell-time" value={outputThroughputLabel(entry)} tooltip="平均输出吞吐 = 输出 Token / 总耗时，包含等待时间，非纯生成速度。" /></td>
    </>
  );
}, (previous, next) => previous.showAllColumns === next.showAllColumns && (previous.entry === next.entry ||
  // HTTP snapshots recreate metadata objects; equal data needs no cell render.
  JSON.stringify(previous.entry) === JSON.stringify(next.entry)));
