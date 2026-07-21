import { describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import {
  selectStaggeredLogIds,
  shouldResetStaggeredLogs
} from "../src/ui/logs/useStaggeredLogs.js";

describe("staggered log query changes", () => {
  it("resets on a new applied query even when rows overlap", () => {
    expect(shouldResetStaggeredLogs(
      [log("p3"), log("p2"), log("p1")],
      [log("c4"), log("p3"), log("c2"), log("p2"), log("p1")],
      "primary",
      "all",
      1,
      1
    )).toBe(true);
  });

  it("resets overlapping rows after an authoritative bulk sync", () => {
    expect(shouldResetStaggeredLogs(
      [log("p3"), log("p2")],
      [log("new"), log("p3"), log("p2")],
      "all",
      "all",
      1,
      2
    )).toBe(true);
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
});

function log(requestId: string): RequestLogEntry {
  return { request_id: requestId } as RequestLogEntry;
}
