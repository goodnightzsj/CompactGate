import { describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import {
  countPrependedLogs,
  planPrependedLogScroll
} from "../src/ui/logs/useLogTableScroll.js";

describe("log viewport follow state", () => {
  it("counts only rows prepended ahead of the visible first row", () => {
    expect(countPrependedLogs(
      [log("old-2"), log("old-1")],
      [log("new-2"), log("new-1"), log("old-2"), log("old-1")]
    )).toBe(2);
  });

  it("does not treat an in-place row update as unseen", () => {
    expect(countPrependedLogs(
      [log("current")],
      [{ ...log("current"), status: 201 }]
    )).toBe(0);
  });

  it("does not treat pagination appended at the tail as unseen", () => {
    expect(countPrependedLogs(
      [log("current")],
      [log("current"), log("older")]
    )).toBe(0);
  });

  it("keeps the latest rows visible while already at the top", () => {
    expect(planPrependedLogScroll(0, 80, 2)).toEqual({
      scrollTop: 0,
      unseenIncrement: 0
    });
  });

  it("preserves a reading anchor and reports unseen rows away from the top", () => {
    expect(planPrependedLogScroll(120, 80, 2)).toEqual({
      scrollTop: 200,
      unseenIncrement: 2
    });
  });

  it("preserves the reading anchor when a full window keeps the same height", () => {
    expect(planPrependedLogScroll(120, 44, 1)).toEqual({
      scrollTop: 164,
      unseenIncrement: 1
    });
  });
});

function log(requestId: string): RequestLogEntry {
  return { request_id: requestId } as RequestLogEntry;
}
