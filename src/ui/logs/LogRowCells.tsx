import { memo } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatCompactMetricNumber, formatDateTime, formatDurationMs } from "../shared/format.js";
import { GENERATION_THROUGHPUT_HINT, generationThroughputLabel, LogModelSummary, LogThroughputSummary, LogTimingSummary, outputThroughputLabel } from "./LogSummary.js";
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
import { displayTotalTokens, formatCacheHitRate, totalInputTokens } from "./log-token-metrics.js";

/**
 * The heavy part of a desktop log row — every tooltip cell. The motion row
 * frame around it changes on stagger ticks, but identical metadata skips cell
 * work both when a row shifts and when an HTTP snapshot recreates its object.
 */
export const LogRowCells = memo(function LogRowCells({
  entry,
  showAllColumns,
  offscreen = false
}: {
  entry: RequestLogEntry;
  showAllColumns: boolean;
  offscreen?: boolean;
}) {
  const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
  const responseEvidence = hasResponseModelMismatch(entry) ? "响应声明不同" : responseModelSourceLabel(entry);
  const throughputHint = `生成 ${generationThroughputLabel(entry)} · 平均 ${outputThroughputLabel(entry)}\n${GENERATION_THROUGHPUT_HINT}\n平均输出吞吐 = 输出 Token / 总耗时，包含等待时间。`;
  // Retain the model/transport stacks so visibility never changes row height.
  const modelCell = <td>
    <LogTextTooltip className="log-model-cell" value={modelMapping}
      tooltip={`${modelMapping}\n响应模型：${responseModelDisplay(entry)} · ${responseModelSourceLabel(entry)}`}>
      <span className="log-model-route-badges">
        <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
        {entry.compaction_mode && <span className={`protocol-chip ${compactionModeClass(entry.compaction_mode)}`}>{compactionModeLabel(entry.compaction_mode)}</span>}
      </span>
      <LogModelSummary entry={entry} />
    </LogTextTooltip>
  </td>;
  const transportCell = <td><LogTextTooltip className="log-summary-stack" value={entry.request_type} tooltip={throughputHint}>
    <span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span>
    <LogThroughputSummary entry={entry} />
  </LogTextTooltip></td>;

  if (offscreen) return <>
    <td><time dateTime={entry.time}>{formatDateTime(entry.time)}</time></td>
    <td>{entry.status}{logStatusKind(entry) === "error" ? " 请求异常" : ""}</td>
    {modelCell}
    {showAllColumns && <><td>{reasoningEffortLabel(entry)}</td><td>{responseModelDisplay(entry)} · {responseEvidence}</td></>}
    <td>{entry.upstream_host}{!showAllColumns && entry.key_name ? ` · 上游凭据 ${entry.key_name}` : ""}</td>
    {showAllColumns && <><td>{entry.key_name ?? "—"}</td><td>{entry.endpoint}</td>{transportCell}</>}
    <td>{formatCompactMetricNumber(displayTotalTokens(entry))} · 入 {formatCompactMetricNumber(totalInputTokens(entry))} · 出 {formatCompactMetricNumber(entry.output_tokens)} · 缓存命中率 {formatCacheHitRate(entry)}</td>
    <td>{showAllColumns ? formatDurationMs(entry.first_token_ms) : `总 ${formatDurationMs(entry.duration_ms)} · 首 ${formatDurationMs(entry.first_token_ms)}`}</td>
    <td>{showAllColumns ? formatDurationMs(entry.duration_ms) : generationThroughputLabel(entry)}</td>
  </>;

  return (
    <>
      <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)}><time dateTime={entry.time}>{formatDateTime(entry.time)}</time></LogTextTooltip></td>
      <td><span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>
        {logStatusKind(entry) === "error" && <span className="visually-hidden"> 请求异常</span>}
      </td>
      {modelCell}
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
        {transportCell}
      </>}
      <td><TokenTooltip entry={entry} /></td>
      <td><LogTextTooltip className="log-cell-time" value="首响应是首个数据块，非首个生成 Token">
        {showAllColumns ? formatDurationMs(entry.first_token_ms) : <LogTimingSummary entry={entry} />}
      </LogTextTooltip></td>
      <td><LogTextTooltip className="log-cell-time"
        value={showAllColumns ? formatDurationMs(entry.duration_ms) : generationThroughputLabel(entry)}
        tooltip={showAllColumns ? "请求总耗时（包含等待时间）" : throughputHint}>
        {showAllColumns ? formatDurationMs(entry.duration_ms) : <LogThroughputSummary entry={entry} />}
      </LogTextTooltip></td>
    </>
  );
}, (previous, next) => previous.offscreen === next.offscreen && previous.showAllColumns === next.showAllColumns && (previous.entry === next.entry ||
  // HTTP snapshots recreate metadata objects; equal data needs no cell render.
  JSON.stringify(previous.entry) === JSON.stringify(next.entry)));
