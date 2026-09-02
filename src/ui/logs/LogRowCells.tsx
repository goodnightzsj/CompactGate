import { memo } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatDateTime, formatDurationMs } from "../shared/format.js";
import { LogTextTooltip, TokenTooltip } from "./LogTooltips.js";
import {
  logStatusToneClass,
  reasoningEffortLabel,
  responseModelDisplay,
  compactionModeClass,
  compactionModeLabel
} from "./log-utils.js";

/**
 * The heavy part of a desktop log row — every tooltip cell. The motion row
 * frame around it is rebuilt on each stagger tick (AnimatePresence has to diff
 * its direct children), but with entry being a stable array reference and this
 * component memoized, the cell work is skipped for rows that merely shift.
 */
export const LogRowCells = memo(function LogRowCells({
  entry
}: {
  entry: RequestLogEntry;
}) {
  const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
  const hasRewrite = Boolean(entry.source_model && entry.target_model && entry.source_model !== entry.target_model);

  return (
    <>
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
      <td><LogTextTooltip className="log-cell-code" value={entry.key_name ?? "—"} /></td>
      <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
      <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
      <td><TokenTooltip entry={entry} /></td>
      <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.first_token_ms)} /></td>
      <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.duration_ms)} /></td>
    </>
  );
});