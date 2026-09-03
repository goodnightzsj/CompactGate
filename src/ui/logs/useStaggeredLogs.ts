import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RequestLogEntry } from "../../shared/types.js";

export const STAGGER_BASE_MS = 120;
export const MAX_STAGGER_DURATION_MS = 2000;
const STAGGER_ROW_CAP = 8;

// Mirrors axonhub's getMaxSequentialAnimatedItems: whichever of the row cap and
// the wall-clock budget binds first wins, so retuning STAGGER_BASE_MS cannot
// silently stretch the reveal past MAX_STAGGER_DURATION_MS.
export const INSTANT_THRESHOLD = Math.min(
  STAGGER_ROW_CAP,
  Math.floor(MAX_STAGGER_DURATION_MS / STAGGER_BASE_MS)
);

/**
 * Returns a displayed list that gradually catches up to the live `logs` array,
 * plus the number of rows still queued behind it.
 *
 * Routing is by provenance, not by size: only a genuine SSE insert is revealed
 * one row at a time. Everything that means "here is the current state" rather
 * than "this just happened" replaces the list outright.
 *
 * - SSE live insert (new rows at head): released one-by-one every STAGGER_BASE_MS.
 * - Initial load / filter change / empty result: immediate.
 * - Snapshot sync (syncVersion bump: page fetch, SSE reconnect merge): immediate.
 * - Visibility or page resume: immediate — a backlog banked while hidden is
 *   state to catch up on, not a sequence worth replaying.
 * - Inactive log page: the visible snapshot freezes and no queue is banked.
 * - Live bursts above INSTANT_THRESHOLD: immediate (rail, rarely reached).
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
    prevActive: active,
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
    // Any of these three means the list is being restated rather than appended
    // to: a query/empty reset, a full snapshot (first fetch, SSE reconnect
    // merge), or the page coming back into view. Queueing them is what made a
    // long-frozen tab crawl back one row at a time.
    const restated = (
      shouldResetStaggeredLogs(logs, state.prevQueryKey, queryKey) ||
      state.prevSyncVersion !== syncVersion ||
      (active && !state.prevActive)
    );

    if (restated) {
      state.queue = [];
      clearTimer();
      replaceDisplayed(logs);
    } else if (!active) {
      // Drop rather than bank the queue: the resume branch above replaces the
      // whole list, so a banked queue would only be stale work.
      state.queue = [];
      clearTimer();
    } else {
      const pendingIds = [
        ...state.queue.map((entry) => entry.request_id),
        ...selectStaggeredLogIds(state.prevLogs, logs, liveInsertIds)
      ];
      const plan = planStaggeredLogCatchUp(state.displayed, logs, pendingIds);

      if (plan.queue.length > INSTANT_THRESHOLD) {
        // Rail, not the main mechanism — with provenance routing the live queue
        // is a handful of rows. Falling through with an empty queue also resets
        // pendingCount below.
        state.queue = [];
        clearTimer();
        replaceDisplayed(logs);
      } else {
        state.queue = plan.queue;
        replaceDisplayed(plan.displayed);
        if (plan.queue.length === 0) {
          clearTimer();
        }
      }
    }

    setPendingCount(state.queue.length);
    state.prevLogs = logs;
    state.prevActive = active;
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
    }, STAGGER_BASE_MS);
  });

  useEffect(() => () => clearTimer(), []);

  return { logs: displayed, pendingCount };
}

/** Estimated ms to reveal `length` queued rows at the fixed cadence. */
export function estimateStaggerDuration(length: number): number {
  return length * STAGGER_BASE_MS;
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
