import { describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import {
  planStaggeredLogCatchUp,
  revealStaggeredLog,
  selectStaggeredLogIds,
  shouldResetStaggeredLogs
} from "../src/ui/logs/useStaggeredLogs.js";

describe("staggered log query changes", () => {
  it("resets on a new applied query even when rows overlap", () => {
    expect(shouldResetStaggeredLogs(
      [log("c4"), log("p3"), log("c2"), log("p2"), log("p1")],
      "primary",
      "all"
    )).toBe(true);
  });

  it("keeps a replaced same-query window eligible for bounded catch-up", () => {
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

  it("replays a small catch-up oldest-first without replacing the visible list", () => {
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

  it("replays every row in a large catch-up without fast-forwarding", () => {
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
