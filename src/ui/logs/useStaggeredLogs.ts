import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RequestLogEntry } from "../../shared/types.js";

export const STAGGER_MS = 150;

/**
 * Returns a displayed list that gradually catches up to the live `logs` array.
 *
 * - Initial load / filter reset: all logs appear immediately (no stagger).
 * - SSE live push (new logs at head): released one-by-one every STAGGER_MS.
 * - Inactive log page: the visible snapshot freezes until the page becomes active.
 * - Page/visibility resume: drains the backlog collected while inactive.
 * - Pagination (older logs at tail): appear immediately.
 * - Existing rows are updated in-place when their fields change.
 */
export function useStaggeredLogs(
  logs: RequestLogEntry[],
  queryKey = "default",
  syncVersion = 0,
  liveInsertIds: readonly string[] = [],
  active = true
): RequestLogEntry[] {
  const [displayed, setDisplayed] = useState<RequestLogEntry[]>(logs);
  const displayedRef = useRef(displayed);
  const queueRef = useRef<RequestLogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [queueVersion, setQueueVersion] = useState(0);
  const prevLogsRef = useRef<RequestLogEntry[]>(logs);
  const prevQueryKeyRef = useRef(queryKey);
  const prevSyncVersionRef = useRef(syncVersion);
  const latestLogsRef = useRef(logs);

  const scheduleQueueDrain = useCallback(() => {
    if (!active || timerRef.current || queueRef.current.length === 0) {
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const item = queueRef.current.shift();
      if (item) {
        setDisplayed((prev) => {
          const next = revealStaggeredLog(prev, latestLogsRef.current, item);
          displayedRef.current = next;
          return next;
        });
      }
      setQueueVersion((version) => version + 1);
    }, STAGGER_MS);
  }, [active]);

  useLayoutEffect(() => {
    latestLogsRef.current = logs;
    const syncChanged = prevSyncVersionRef.current !== syncVersion;
    const isReset = shouldResetStaggeredLogs(
      logs,
      prevQueryKeyRef.current,
      queryKey
    );
    const isInitialSync = shouldApplyInitialStaggeredSync(
      prevSyncVersionRef.current,
      syncVersion,
      prevLogsRef.current,
      displayedRef.current
    );

    const rememberInputs = () => {
      prevLogsRef.current = logs;
      prevQueryKeyRef.current = queryKey;
      prevSyncVersionRef.current = syncVersion;
    };

    const replaceDisplayed = (next: RequestLogEntry[]) => {
      displayedRef.current = next;
      setDisplayed((current) => sameLogEntries(current, next) ? current : next);
    };

    if (isReset || isInitialSync) {
      queueRef.current = [];
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      replaceDisplayed(logs);
      rememberInputs();
      return;
    }

    if (!active) {
      const visibleIds = new Set(displayedRef.current.map((entry) => entry.request_id));
      const pendingIds = syncChanged
        ? logs
          .filter((entry) => !visibleIds.has(entry.request_id))
          .map((entry) => entry.request_id)
        : [
          ...queueRef.current.map((entry) => entry.request_id),
          ...selectStaggeredLogIds(prevLogsRef.current, logs, liveInsertIds)
        ];
      const plan = planStaggeredLogCatchUp(displayedRef.current, logs, pendingIds);
      queueRef.current = plan.queue;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      rememberInputs();
      return;
    }

    let pendingIds: string[];
    if (syncChanged) {
      const visibleIds = new Set(displayedRef.current.map((entry) => entry.request_id));
      pendingIds = logs
        .filter((entry) => !visibleIds.has(entry.request_id))
        .map((entry) => entry.request_id);
    } else {
      pendingIds = [
        ...queueRef.current.map((entry) => entry.request_id),
        ...selectStaggeredLogIds(prevLogsRef.current, logs, liveInsertIds)
      ];
    }

    const plan = planStaggeredLogCatchUp(displayedRef.current, logs, pendingIds);
    queueRef.current = plan.queue;
    replaceDisplayed(plan.displayed);
    if (plan.queue.length > 0) {
      setQueueVersion((version) => version + 1);
    } else if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    rememberInputs();
  }, [active, liveInsertIds, logs, queryKey, syncVersion]);

  useEffect(() => {
    if (!active) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }

    scheduleQueueDrain();
  }, [active, queueVersion, scheduleQueueDrain]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return displayed;
}

export function shouldResetStaggeredLogs(
  nextLogs: RequestLogEntry[],
  previousQueryKey: string,
  nextQueryKey: string
): boolean {
  return (
    previousQueryKey !== nextQueryKey ||
    nextLogs.length === 0
  );
}

export function shouldApplyInitialStaggeredSync(
  previousSyncVersion: number,
  nextSyncVersion: number,
  previousLogs: RequestLogEntry[],
  displayed: RequestLogEntry[]
): boolean {
  return (
    previousSyncVersion === 0 &&
    previousSyncVersion !== nextSyncVersion &&
    previousLogs.length === 0 &&
    displayed.length === 0
  );
}

export function selectStaggeredLogIds(
  previousLogs: RequestLogEntry[],
  nextLogs: RequestLogEntry[],
  liveInsertIds: readonly string[]
): string[] {
  const previousIds = new Set(previousLogs.map((entry) => entry.request_id));
  const liveIds = new Set(liveInsertIds);

  return nextLogs
    .filter((entry) => !previousIds.has(entry.request_id) && liveIds.has(entry.request_id))
    .map((entry) => entry.request_id)
    .reverse();
}

export function planStaggeredLogCatchUp(
  displayed: RequestLogEntry[],
  latest: RequestLogEntry[],
  pendingIds: readonly string[]
): { displayed: RequestLogEntry[]; queue: RequestLogEntry[] } {
  const displayedIds = new Set(displayed.map((entry) => entry.request_id));
  const pendingIdSet = new Set(pendingIds);
  const pending = latest
    .filter((entry) => pendingIdSet.has(entry.request_id) && !displayedIds.has(entry.request_id))
    .reverse();
  const queue = pending;
  const queueIds = new Set(queue.map((entry) => entry.request_id));

  const latestIds = new Set(latest.map((entry) => entry.request_id));
  const visibleIds = new Set(displayedIds);
  for (const entry of latest) {
    if (!pendingIdSet.has(entry.request_id)) {
      visibleIds.add(entry.request_id);
    }
  }

  const current = latest.filter(
    (entry) => visibleIds.has(entry.request_id) && !queueIds.has(entry.request_id)
  );
  const stale = displayed.filter((entry) => !latestIds.has(entry.request_id));
  const targetLength = Math.max(
    Math.min(displayed.length, latest.length),
    latest.length - queue.length
  );

  return {
    displayed: [...current, ...stale].slice(0, targetLength),
    queue
  };
}

export function revealStaggeredLog(
  displayed: RequestLogEntry[],
  latest: RequestLogEntry[],
  entry: RequestLogEntry
): RequestLogEntry[] {
  const latestIds = new Set(latest.map((item) => item.request_id));
  const visibleIds = new Set(displayed.map((item) => item.request_id));
  visibleIds.add(entry.request_id);

  const current = latest.filter((item) => visibleIds.has(item.request_id));
  const stale = displayed.filter((item) => !latestIds.has(item.request_id));
  const targetLength = Math.min(latest.length, Math.max(displayed.length, current.length));
  return [...current, ...stale].slice(0, targetLength);
}

function sameLogEntries(left: RequestLogEntry[], right: RequestLogEntry[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}
