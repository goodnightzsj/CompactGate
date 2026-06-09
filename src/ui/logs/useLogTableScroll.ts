import { useEffect, useLayoutEffect, useRef } from "react";
import type { UIEvent } from "react";
import type { RequestLogEntry } from "../../shared/types.js";

const LOG_LAZY_LOAD_THRESHOLD_PX = 220;
const LOG_STICKY_TOP_THRESHOLD_PX = 24;

export function useLogTableScroll({
  hasMoreLogs,
  isLoadingLogs,
  isLoadingMoreLogs,
  logs,
  onLoadMore
}: {
  hasMoreLogs: boolean;
  isLoadingLogs: boolean;
  isLoadingMoreLogs: boolean;
  logs: RequestLogEntry[];
  onLoadMore: () => void;
}) {
  const tableBodyRef = useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = useRef({
    firstLogId: null as string | null,
    scrollHeight: 0,
    scrollTop: 0
  });
  const autoLoadPendingRef = useRef(false);

  useEffect(() => {
    if (!isLoadingMoreLogs) {
      autoLoadPendingRef.current = false;
    }
  }, [isLoadingMoreLogs, logs.length]);

  useLayoutEffect(() => {
    const body = tableBodyRef.current;
    if (!body) {
      return;
    }

    const previous = scrollSnapshotRef.current;
    const firstLogId = logs[0]?.request_id ?? null;
    const previousFirstIndex = previous.firstLogId
      ? logs.findIndex((entry) => entry.request_id === previous.firstLogId)
      : -1;
    const liveLogsWerePrepended = previousFirstIndex > 0 && firstLogId !== previous.firstLogId;

    if (liveLogsWerePrepended && previous.scrollTop > LOG_STICKY_TOP_THRESHOLD_PX) {
      const delta = body.scrollHeight - previous.scrollHeight;
      if (delta > 0) {
        body.scrollTop = previous.scrollTop + delta;
      }
    }

    scrollSnapshotRef.current = {
      firstLogId,
      scrollHeight: body.scrollHeight,
      scrollTop: body.scrollTop
    };
  }, [logs]);

  function handleLogScroll(event: UIEvent<HTMLDivElement>) {
    const body = event.currentTarget;
    scrollSnapshotRef.current = {
      ...scrollSnapshotRef.current,
      scrollHeight: body.scrollHeight,
      scrollTop: body.scrollTop
    };

    const remainingScroll = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (
      remainingScroll <= LOG_LAZY_LOAD_THRESHOLD_PX &&
      hasMoreLogs &&
      !isLoadingLogs &&
      !isLoadingMoreLogs &&
      !autoLoadPendingRef.current
    ) {
      autoLoadPendingRef.current = true;
      onLoadMore();
    }
  }

  return {
    handleLogScroll,
    tableBodyRef
  };
}
