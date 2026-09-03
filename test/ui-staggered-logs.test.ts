import { describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import {
  INSTANT_THRESHOLD,
  MAX_STAGGER_DURATION_MS,
  STAGGER_BASE_MS,
  estimateStaggerDuration,
  planStaggeredLogCatchUp,
  revealStaggeredLog,
  selectStaggeredLogIds,
  shouldResetStaggeredLogs
} from "../src/ui/logs/useStaggeredLogs.js";

describe("staggered log query changes", () => {
  it("uses a 120ms fixed insertion cadence", () => {
    expect(STAGGER_BASE_MS).toBe(120);
  });

  it("caps the reveal so a full queue stays inside the duration budget", () => {
    // Guards the cadence constant itself: raising STAGGER_BASE_MS far enough
    // that a full queue outlasts the budget has to fail here.
    expect(INSTANT_THRESHOLD).toBeGreaterThan(0);
    expect(estimateStaggerDuration(INSTANT_THRESHOLD))
      .toBeLessThanOrEqual(MAX_STAGGER_DURATION_MS);
  });

  it("resets on a new applied query even when rows overlap", () => {
    expect(shouldResetStaggeredLogs(
      [log("c4"), log("p3"), log("c2"), log("p2"), log("p1")],
      "primary",
      "all"
    )).toBe(true);
  });

  it("keeps a replaced same-query window eligible for live catch-up", () => {
    expect(shouldResetStaggeredLogs(
      [log("new-2"), log("new-1")],
      "all",
      "all"
    )).toBe(false);
  });

  it("does not stagger an overlapping historical batch without an explicit live marker", () => {
    expect(selectStaggeredLogIds(
      [log("known")],
      [log("newest"), log("newer"), log("known")],
      []
    )).toEqual([]);
  });

  it("queues only explicit live inserts and releases the oldest one first", () => {
    expect(selectStaggeredLogIds(
      [log("known")],
      [log("newest"), log("newer"), log("known")],
      ["newest", "newer"]
    )).toEqual(["newer", "newest"]);
  });

  it("queues foreground live inserts oldest-first without replacing the visible list", () => {
    const displayed = [log("old-3"), log("old-2"), log("old-1")];
    const latest = [log("new-2"), log("new-1"), log("old-3")];
    const plan = planStaggeredLogCatchUp(
      displayed,
      latest,
      ["new-2", "new-1"]
    );

    expect(ids(plan.displayed)).toEqual(ids(displayed));
    expect(ids(plan.queue)).toEqual(["new-1", "new-2"]);
    expect(ids(drain(plan.displayed, latest, plan.queue))).toEqual(ids(latest));
  });

  it("queues every pending id the caller marks, leaving the cap to the caller", () => {
    const displayed = [log("old-3"), log("old-2"), log("old-1")];
    const latest = [log("new-2"), log("new-1"), log("old-3")];
    const plan = planStaggeredLogCatchUp(
      displayed,
      latest,
      latest.map((entry) => entry.request_id)
    );

    expect(ids(plan.displayed)).toEqual(ids(displayed));
    expect(ids(plan.queue)).toEqual(["new-1", "new-2"]);
  });

  it("plans a full-window replacement as a drainable queue", () => {
    const displayed = Array.from({ length: 10 }, (_, index) => log(`old-${10 - index}`));
    const latest = Array.from({ length: 48 }, (_, index) => log(`new-${48 - index}`));
    const plan = planStaggeredLogCatchUp(
      displayed,
      latest,
      latest.map((entry) => entry.request_id)
    );

    expect(ids(plan.displayed)).toEqual(ids(displayed));
    expect(ids(plan.queue)).toEqual(
      Array.from({ length: 48 }, (_, index) => `new-${index + 1}`)
    );
    expect(ids(drain(plan.displayed, latest, plan.queue))).toEqual(ids(latest));
  });

  it("advances the newest visible row one-by-one when the log window is full", () => {
    const displayed = Array.from({ length: 48 }, (_, index) => log(`old-${48 - index}`));
    const latest = Array.from({ length: 48 }, (_, index) => log(`new-${48 - index}`));
    const plan = planStaggeredLogCatchUp(
      displayed,
      latest,
      latest.map((entry) => entry.request_id)
    );
    let current = plan.displayed;
    const newestVisibleIds = plan.queue.map((entry) => {
      current = revealStaggeredLog(current, latest, entry);
      expect(current).toHaveLength(displayed.length);
      return current[0]?.request_id;
    });

    expect(newestVisibleIds).toEqual(
      Array.from({ length: 48 }, (_, index) => `new-${index + 1}`)
    );
    expect(ids(current)).toEqual(ids(latest));
  });

  it("does not reveal an unqueued late arrival with the final queued row", () => {
    const displayed = [log("old")];
    const latest = [log("late"), log("queued"), log("old")];

    expect(ids(revealStaggeredLog(displayed, latest, log("queued"))))
      .toEqual(["queued", "old"]);
  });
});

function drain(
  displayed: RequestLogEntry[],
  latest: RequestLogEntry[],
  queue: RequestLogEntry[]
): RequestLogEntry[] {
  return queue.reduce(
    (current, entry) => revealStaggeredLog(current, latest, entry),
    displayed
  );
}

function ids(logs: RequestLogEntry[]): string[] {
  return logs.map((entry) => entry.request_id);
}

function log(requestId: string): RequestLogEntry {
  return { request_id: requestId } as RequestLogEntry;
}
