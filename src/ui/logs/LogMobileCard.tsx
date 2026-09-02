import { memo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatDateTime, formatDurationMs, formatMetricNumber } from "../shared/format.js";
import { LogDetailPanel } from "./LogDetailRow.js";
import {
  compactionModeClass,
  compactionModeLabel,
  displayTotalTokens,
  logStatusKind,
  logStatusToneClass
} from "./log-utils.js";

export const LogMobileCard = memo(function LogMobileCard({
  entry,
  logKey,
  detailId,
  expanded,
  onToggle
}: {
  entry: RequestLogEntry;
  logKey: string;
  detailId: string;
  expanded: boolean;
  onToggle: (logKey: string) => void;
}) {
  const targetModel = entry.target_model ?? entry.source_model ?? "-";
  const modelLabel = entry.source_model && entry.source_model !== targetModel
    ? `${entry.source_model} → ${targetModel}`
    : targetModel;
  const hasError = logStatusKind(entry) === "error";
  const reduceMotion = useReducedMotion();

  return (
    <article className={`log-mobile-card ${hasError ? "has-error" : ""}`}>
      <button
        className="log-mobile-summary"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => onToggle(logKey)}
      >
        <span className="log-mobile-head">
          <span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>
          <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
          {entry.compaction_mode && <span className={`protocol-chip ${compactionModeClass(entry.compaction_mode)}`}>{compactionModeLabel(entry.compaction_mode)}</span>}
          <time>{formatDateTime(entry.time)}</time>
        </span>
        <strong className="log-mobile-model">{modelLabel}</strong>
        <span className="log-mobile-host">{entry.upstream_host}</span>
        {entry.key_name && <span className="log-mobile-key">{entry.key_name}</span>}
        <span className="log-mobile-endpoint">{entry.endpoint}</span>
        <span className="log-mobile-metrics">
          <span>{entry.request_type}</span>
          <span>{formatMetricNumber(displayTotalTokens(entry))} Token</span>
          <span>{formatDurationMs(entry.duration_ms)}</span>
        </span>
        <span className="log-mobile-disclosure" aria-hidden="true">{expanded ? "收起" : "详情"}</span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="log-mobile-detail"
            id={detailId}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={reduceMotion ? { duration: 0.01 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <LogDetailPanel entry={entry} />
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
});
