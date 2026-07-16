import { AnimatePresence, motion } from "framer-motion";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatDateTime, formatDurationMs, formatMetricNumber } from "../shared/format.js";
import { LogDetailPanel } from "./LogDetailRow.js";
import { displayTotalTokens, logStatusToneClass } from "./log-utils.js";

export function LogMobileCard({
  entry,
  detailId,
  expanded,
  onToggle
}: {
  entry: RequestLogEntry;
  detailId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const targetModel = entry.target_model ?? entry.source_model ?? "-";
  const modelLabel = entry.source_model && entry.source_model !== targetModel
    ? `${entry.source_model} → ${targetModel}`
    : targetModel;
  const hasError = Boolean(entry.error_summary) || entry.status >= 400;

  return (
    <article className={`log-mobile-card ${hasError ? "has-error" : ""}`}>
      <button
        className="log-mobile-summary"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <span className="log-mobile-head">
          <span className={`log-status ${logStatusToneClass(entry)}`}>{entry.status}</span>
          <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
          <time>{formatDateTime(entry.time)}</time>
        </span>
        <strong className="log-mobile-model">{modelLabel}</strong>
        <span className="log-mobile-host">{entry.upstream_host}</span>
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
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <LogDetailPanel entry={entry} />
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}
