import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RequestLogEntry } from "../../shared/types.js";

export const STAGGER_BASE_MS = 150;
export const STAGGER_FAST_MS = 60;
export const FAST_DRAIN_THRESHOLD = 20;

/**
 * Returns a displayed list that gradually catches up to the live `logs` array,
 * plus the number of rows still queued behind it.
 *
 * - Initial load / filter reset: all logs appear immediately (no stagger).
 * - SSE live push (new logs at head): released one-by-one every STAGGER_BASE_MS.
 * - Large backlogs (>20 pending): accelerated to STAGGER_FAST_MS for faster drain.
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
): { logs: RequestLogEntry[]; pendingCount: number } {
  const [displayed, setDisplayed] = useState<RequestLogEntry[]>(logs);
  const [pendingCount, setPendingCount] = useState(0);
  const state = useRef({
    displayed,
    queue: [] as RequestLogEntry[],
    timer: null as ReturnType<typeof setTimeout> | null,
    latestLogs: logs,
    prevLogs: logs,
    prevQueryKey: queryKey,
    prevSyncVersion: syncVersion
  }).current;

  const clearTimer = () => {
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = null;
  };

  useLayoutEffect(() => {
    const replaceDisplayed = (next: RequestLogEntry[]) => {
      state.displayed = next;
      setDisplayed((current) => sameLogEntries(current, next) ? current : next);
    };

    state.latestLogs = logs;
    const syncChanged = state.prevSyncVersion !== syncVersion;
    const isReset = shouldResetStaggeredLogs(logs, state.prevQueryKey, queryKey);
    const isInitialSync = shouldApplyInitialStaggeredSync(
      state.prevSyncVersion,
      syncVersion,
      state.prevLogs,
      state.displayed
    );

    if (isReset || isInitialSync) {
      state.queue = [];
      clearTimer();
      replaceDisplayed(logs);
    } else {
      const visibleIds = new Set(state.displayed.map((entry) => entry.request_id));
      const pendingIds = syncChanged
        ? logs
          .filter((entry) => !visibleIds.has(entry.request_id))
          .map((entry) => entry.request_id)
        : [
          ...state.queue.map((entry) => entry.request_id),
          ...selectStaggeredLogIds(state.prevLogs, logs, liveInsertIds)
        ];
      const plan = planStaggeredLogCatchUp(state.displayed, logs, pendingIds);
      state.queue = plan.queue;
      if (active) {
        replaceDisplayed(plan.displayed);
      }
      // A queued backlog is drained by the post-commit effect below; anything
      // left pending while inactive stays frozen with no timer running.
      if (!active || plan.queue.length === 0) {
        clearTimer();
      }
    }

    setPendingCount(state.queue.length);
    state.prevLogs = logs;
    state.prevQueryKey = queryKey;
    state.prevSyncVersion = syncVersion;
  }, [active, liveInsertIds, logs, queryKey, syncVersion]);

  // Intentionally dep-free: it must re-arm after every commit that reveals a row
  // or refills the queue. Re-running is a no-op while a timer is already pending.
  useEffect(() => {
    if (!active) {
      clearTimer();
      return;
    }

    if (state.timer || state.queue.length === 0) {
      return;
    }

    const delay = state.queue.length > FAST_DRAIN_THRESHOLD ? STAGGER_FAST_MS : STAGGER_BASE_MS;
    state.timer = setTimeout(() => {
      state.timer = null;
      const item = state.queue.shift();
      if (item) {
        setPendingCount(state.queue.length);
        setDisplayed((previous) => {
          const next = revealStaggeredLog(previous, state.latestLogs, item);
          state.displayed = next;
          return next;
        });
      }
    }, delay);
  });

  useEffect(() => () => clearTimer(), []);

  return { logs: displayed, pendingCount };
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
