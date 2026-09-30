import { memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useMediaQuery } from "./useNarrowViewport.js";
import { routeLabel } from "../../shared/route-meta.js";
import type { RequestLogEntry } from "../../shared/types.js";
import { formatDateTime } from "../shared/format.js";
import { LogModelSummary, LogTokenSummary, LogTimingSummary, outputThroughputLabel } from "./LogSummary.js";
import { LogDetailPanel } from "./LogDetailRow.js";
import {
  compactionModeClass,
  compactionModeLabel,
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
  const hasError = logStatusKind(entry) === "error";
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  return (
    <article className={`log-mobile-card ${hasError ? "has-error" : ""}`}>
      <button
        className="log-mobile-summary"
        id={`${detailId}-trigger`}
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
        <span className="log-mobile-model"><LogModelSummary entry={entry} /></span>
        <span className="log-mobile-host">{entry.upstream_host}</span>
        {entry.key_name && <span className="log-mobile-key">上游凭据 · {entry.key_name}</span>}
        <span className="log-mobile-endpoint">{entry.endpoint}</span>
        <span className="log-mobile-metrics">
          <span>{entry.request_type}</span>
          <LogTokenSummary entry={entry} />
          <LogTimingSummary entry={entry} />
          <span>平均 {outputThroughputLabel(entry)}</span>
        </span>
        {hasError && <span className="log-error-hint">{entry.error_summary ?? entry.stream_outcome ?? "请求未成功"}</span>}
        <span className="log-mobile-disclosure" aria-hidden="true">{expanded ? "收起" : "详情"}</span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="log-mobile-detail"
            id={detailId}
            initial={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
            transition={reduceMotion ? { duration: 0.01 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <LogDetailPanel entry={entry} onCollapse={() => {
              onToggle(logKey);
              document.getElementById(`${detailId}-trigger`)?.focus({ preventScroll: true });
            }} />
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
});
