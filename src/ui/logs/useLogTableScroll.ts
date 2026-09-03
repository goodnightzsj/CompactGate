import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import type { RequestLogEntry } from "../../shared/types.js";

const LOG_LAZY_LOAD_THRESHOLD_PX = 220;
const LOG_STICKY_TOP_THRESHOLD_PX = 24;

export function countPrependedLogs(
  previousLogs: RequestLogEntry[],
  nextLogs: RequestLogEntry[]
): number {
  const previousFirstId = previousLogs[0]?.request_id;
  if (!previousFirstId) {
    return 0;
  }

  const previousFirstIndex = nextLogs.findIndex(
    (entry) => entry.request_id === previousFirstId
  );
  return Math.max(0, previousFirstIndex);
}

export function planPrependedLogScroll(
  previousScrollTop: number,
  anchorOffsetDelta: number,
  prependedCount: number
): { scrollTop: number; unseenIncrement: number } {
  if (prependedCount === 0) {
    return { scrollTop: previousScrollTop, unseenIncrement: 0 };
  }

  if (previousScrollTop <= LOG_STICKY_TOP_THRESHOLD_PX) {
    return { scrollTop: 0, unseenIncrement: 0 };
  }

  return {
    scrollTop: previousScrollTop + Math.max(0, anchorOffsetDelta),
    unseenIncrement: prependedCount
  };
}

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
  const mobileListRef = useRef<HTMLDivElement | null>(null);
  const logsRef = useRef(logs);
  logsRef.current = logs;
  const [unseenLogCount, setUnseenLogCount] = useState(0);
  const scrollSnapshotRef = useRef({
    body: null as HTMLDivElement | null,
    logs: [] as RequestLogEntry[],
    firstLogOffset: 0,
    scrollTop: 0
  });
  const autoLoadPendingRef = useRef(false);

  const scrollToLatest = useCallback(() => {
    window.scrollTo(0, 0);
    for (const body of [tableBodyRef.current, mobileListRef.current]) {
      if (body) body.scrollTop = 0;
    }

    const body = visibleLogBody(tableBodyRef.current, mobileListRef.current);
    scrollSnapshotRef.current = {
      body,
      logs: logsRef.current,
      firstLogOffset: firstLogOffset(body, logsRef.current),
      scrollTop: 0
    };
    setUnseenLogCount(0);
  }, []);

  useLayoutEffect(() => {
    scrollToLatest();
  }, [scrollToLatest]);

  useEffect(() => {
    if (!isLoadingMoreLogs) {
      autoLoadPendingRef.current = false;
    }
  }, [isLoadingMoreLogs, logs.length]);

  useLayoutEffect(() => {
    const body = visibleLogBody(tableBodyRef.current, mobileListRef.current);
    if (!body) {
      return;
    }

    const previous = scrollSnapshotRef.current;
    const prependedCount = previous.body === body
      ? countPrependedLogs(previous.logs, logs)
      : 0;

    if (prependedCount > 0) {
      // Measured and corrected synchronously, in the same commit as the insert.
      // Nothing animates layout any more — rows animate opacity and transform
      // only, and offsetTop ignores transforms as well as container scroll
      // (both verified in a browser) — so the anchor already sits at its final
      // position here. The rAF + settle timeout this replaces existed to outwait
      // a height animation that never worked on a <tr>; all it actually bought
      // was a visible one-row drift before the correction landed, plus a stale
      // scrollTop in the snapshot written below.
      const plan = planPrependedLogScroll(
        previous.scrollTop,
        logOffset(body, previous.logs[0]?.request_id) - previous.firstLogOffset,
        prependedCount
      );
      body.scrollTop = plan.scrollTop;
      if (plan.unseenIncrement > 0) {
        setUnseenLogCount((count) => count + plan.unseenIncrement);
      } else {
        setUnseenLogCount(0);
      }
    }

    scrollSnapshotRef.current = {
      body,
      logs,
      firstLogOffset: firstLogOffset(body, logs),
      scrollTop: body.scrollTop
    };
  }, [logs]);

  function handleLogScroll(event: UIEvent<HTMLDivElement>) {
    const body = event.currentTarget;
    rememberScroll(body);

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

  function handleMobileLogScroll(event: UIEvent<HTMLDivElement>) {
    rememberScroll(event.currentTarget);
  }

  function rememberScroll(body: HTMLDivElement) {
    scrollSnapshotRef.current = {
      body,
      logs: logsRef.current,
      firstLogOffset: firstLogOffset(body, logsRef.current),
      scrollTop: body.scrollTop
    };
    if (body.scrollTop <= LOG_STICKY_TOP_THRESHOLD_PX) {
      setUnseenLogCount(0);
    }
  }

  return {
    handleLogScroll,
    handleMobileLogScroll,
    mobileListRef,
    scrollToLatest,
    tableBodyRef,
    unseenLogCount
  };
}

function visibleLogBody(
  tableBody: HTMLDivElement | null,
  mobileList: HTMLDivElement | null
): HTMLDivElement | null {
  const bodies = [tableBody, mobileList].filter(
    (body): body is HTMLDivElement => body !== null
  );
  return bodies.find((body) => body.offsetParent !== null) ?? bodies[0] ?? null;
}

function firstLogOffset(body: HTMLDivElement | null, logs: RequestLogEntry[]): number {
  return body ? logOffset(body, logs[0]?.request_id) : 0;
}

function logOffset(body: HTMLDivElement, requestId: string | undefined): number {
  if (!requestId) return 0;
  const entry = Array.from(body.querySelectorAll<HTMLElement>("[data-log-id]"))
    .find((element) => element.dataset.logId === requestId);
  return entry?.offsetTop ?? 0;
}
