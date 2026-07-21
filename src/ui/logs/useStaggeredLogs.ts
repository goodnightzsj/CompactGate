import { useCallback, useEffect, useRef, useState } from "react";
import type { RequestLogEntry } from "../../shared/types.js";

const STAGGER_MS = 250;

/**
 * Returns a displayed list that gradually catches up to the live `logs` array.
 *
 * - Initial load / filter reset: all logs appear immediately (no stagger).
 * - SSE live push (new logs at head): released one-by-one every STAGGER_MS.
 * - Pagination (older logs at tail): appear immediately.
 * - Existing rows are updated in-place when their fields change.
 */
export function useStaggeredLogs(
  logs: RequestLogEntry[],
  queryKey = "default",
  syncVersion = 0,
  liveInsertIds: readonly string[] = []
): RequestLogEntry[] {
  const [displayed, setDisplayed] = useState<RequestLogEntry[]>(logs);
  const queueRef = useRef<RequestLogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [queueVersion, setQueueVersion] = useState(0);
  const prevLogsRef = useRef<RequestLogEntry[]>(logs);
  const prevQueryKeyRef = useRef(queryKey);
  const prevSyncVersionRef = useRef(syncVersion);
  const latestLogsRef = useRef(logs);

  const scheduleQueueDrain = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (queueRef.current.length === 0) {
      timerRef.current = null;
      return;
    }
    timerRef.current = setInterval(() => {
      const item = queueRef.current.shift();
      if (item) {
        setDisplayed((prev) => {
          const visibleIds = new Set(prev.map((entry) => entry.request_id));
          visibleIds.add(item.request_id);
          return latestLogsRef.current.filter((entry) => visibleIds.has(entry.request_id));
        });
      }
      if (queueRef.current.length === 0 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, STAGGER_MS);
  }, []);

  useEffect(() => {
    latestLogsRef.current = logs;
    const prevIds = new Set(prevLogsRef.current.map((e) => e.request_id));
    const isReset = shouldResetStaggeredLogs(
      prevLogsRef.current,
      logs,
      prevQueryKeyRef.current,
      queryKey,
      prevSyncVersionRef.current,
      syncVersion
    );

    if (isReset) {
      queueRef.current = [];
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      setDisplayed(logs);
      prevLogsRef.current = logs;
      prevQueryKeyRef.current = queryKey;
      prevSyncVersionRef.current = syncVersion;
      return;
    }

    // Build a map of the incoming data for in-place updates.
    const incoming = new Map(logs.map((e) => [e.request_id, e]));
    queueRef.current = queueRef.current
      .filter((item) => incoming.has(item.request_id))
      .map((item) => incoming.get(item.request_id) ?? item);

    const nextStaggeredIds = selectStaggeredLogIds(
      prevLogsRef.current,
      logs,
      liveInsertIds
    );
    const staggeredIds = new Set(nextStaggeredIds);
    const queuedIds = new Set(queueRef.current.map((entry) => entry.request_id));

    // Apply updates and show all non-live additions in canonical server order.
    setDisplayed((prev) => {
      const visibleIds = new Set(prev.map((entry) => entry.request_id));
      for (const entry of logs) {
        if (!prevIds.has(entry.request_id) && !staggeredIds.has(entry.request_id)) {
          visibleIds.add(entry.request_id);
        }
      }
      const updated = logs.filter(
        (entry) => visibleIds.has(entry.request_id) && !queuedIds.has(entry.request_id)
      );
      const unchanged = (
        updated.length === prev.length &&
        updated.every((entry, index) => entry === prev[index])
      );
      return unchanged ? prev : updated;
    });

    const nextQueue = nextStaggeredIds
      .map((requestId) => incoming.get(requestId))
      .filter((entry): entry is RequestLogEntry => Boolean(entry))
      .filter((entry) => !queuedIds.has(entry.request_id));
    if (nextQueue.length > 0) {
      queueRef.current.push(...nextQueue);
      setQueueVersion((v) => v + 1);
    }

    prevLogsRef.current = logs;
    prevQueryKeyRef.current = queryKey;
    prevSyncVersionRef.current = syncVersion;
  }, [logs, queryKey, syncVersion, liveInsertIds]);

  // Re-schedule the stagger drain whenever the queue gets new items.
  useEffect(() => {
    scheduleQueueDrain();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [queueVersion, scheduleQueueDrain]);

  return displayed;
}

export function shouldResetStaggeredLogs(
  previousLogs: RequestLogEntry[],
  nextLogs: RequestLogEntry[],
  previousQueryKey: string,
  nextQueryKey: string,
  previousSyncVersion = 0,
  nextSyncVersion = previousSyncVersion
): boolean {
  if (
    previousQueryKey !== nextQueryKey ||
    previousSyncVersion !== nextSyncVersion ||
    nextLogs.length === 0
  ) {
    return true;
  }

  const previousIds = new Set(previousLogs.map((entry) => entry.request_id));
  return !nextLogs.some((entry) => previousIds.has(entry.request_id));
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
