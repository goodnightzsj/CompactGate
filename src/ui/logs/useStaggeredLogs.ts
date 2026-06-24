import { useCallback, useEffect, useRef, useState } from "react";
import type { RequestLogEntry } from "../../shared/types.js";

const STAGGER_MS = 250;
const MAX_DISPLAYED = 100;

/**
 * Returns a displayed list that gradually catches up to the live `logs` array.
 *
 * - Initial load / filter reset: all logs appear immediately (no stagger).
 * - SSE live push (new logs at head): released one-by-one every STAGGER_MS.
 * - Pagination (older logs at tail): appear immediately.
 * - Existing rows are updated in-place when their fields change.
 */
export function useStaggeredLogs(logs: RequestLogEntry[]): RequestLogEntry[] {
  const [displayed, setDisplayed] = useState<RequestLogEntry[]>(logs);
  const seenIds = useRef<Set<string>>(new Set());
  const queueRef = useRef<RequestLogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [queueVersion, setQueueVersion] = useState(0);
  const prevLogsRef = useRef<RequestLogEntry[]>(logs);

  const scheduleQueueDrain = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (queueRef.current.length === 0) {
      timerRef.current = null;
      return;
    }
    timerRef.current = setInterval(() => {
      const item = queueRef.current.shift();
      if (item) {
        setDisplayed((prev) => [item, ...prev]);
      }
      if (queueRef.current.length === 0 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, STAGGER_MS);
  }, []);

  useEffect(() => {
    // Full reset: empty list or no ID overlap with previous batch.
    const prevIds = new Set(prevLogsRef.current.map((e) => e.request_id));
    const currIds = new Set(logs.map((e) => e.request_id));
    const hasOverlap = logs.length > 0 && [...prevIds].some((id) => currIds.has(id));
    const isReset = !hasOverlap || logs.length === 0;

    if (isReset) {
      queueRef.current = [];
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      setDisplayed(logs);
      seenIds.current = new Set(logs.map((e) => e.request_id));
      prevLogsRef.current = logs;
      return;
    }

    // Build a map of the incoming data for in-place updates.
    const incoming = new Map(logs.map((e) => [e.request_id, e]));

    // Find first known index to split head (SSE) from tail (pagination).
    let firstKnown = -1;
    for (let i = 0; i < logs.length; i++) {
      if (seenIds.current.has(logs[i].request_id)) {
        firstKnown = i;
        break;
      }
    }

    // Mark all current IDs as seen.
    for (const e of logs) seenIds.current.add(e.request_id);

    // Apply in-place updates to already-displayed rows.
    setDisplayed((prev) => {
      let didChange = false;
      const updated = prev.map((item) => {
        const fresh = incoming.get(item.request_id);
        if (fresh && fresh !== item) {
          didChange = true;
          return fresh;
        }
        return item;
      });
      return didChange ? updated : prev;
    });

    // New items at tail (pagination): append immediately to displayed.
    if (firstKnown >= 0) {
      const tail: RequestLogEntry[] = [];
      for (let i = firstKnown; i < logs.length; i++) {
        if (!prevIds.has(logs[i].request_id)) {
          tail.push(logs[i]);
        }
      }
      if (tail.length > 0) {
        setDisplayed((prev) => [...prev, ...tail]);
      }
    }

    // New items at head (SSE): queue for staggered release.
    if (firstKnown > 0) {
      const head: RequestLogEntry[] = [];
      for (let i = firstKnown - 1; i >= 0; i--) {
        if (!prevIds.has(logs[i].request_id)) {
          head.push(logs[i]);
        }
      }
      // Reverse so oldest-first enters the stagger queue (oldest appears first).
      head.reverse();
      if (head.length > 0) {
        queueRef.current.push(...head);
        setQueueVersion((v) => v + 1);
      }
    }

    prevLogsRef.current = logs;
  }, [logs]);

  // Re-schedule the stagger drain whenever the queue gets new items.
  useEffect(() => {
    scheduleQueueDrain();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [queueVersion, scheduleQueueDrain]);

  // Cap displayed length to prevent unbounded growth.
  if (displayed.length > MAX_DISPLAYED) {
    return displayed.slice(0, MAX_DISPLAYED);
  }

  return displayed;
}
