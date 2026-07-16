import { describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import { shouldResetStaggeredLogs } from "../src/ui/logs/useStaggeredLogs.js";

describe("staggered log query changes", () => {
  it("resets on a new applied query even when rows overlap", () => {
    expect(shouldResetStaggeredLogs(
      [log("p3"), log("p2"), log("p1")],
      [log("c4"), log("p3"), log("c2"), log("p2"), log("p1")],
      "primary",
      "all"
    )).toBe(true);
  });

  it("keeps stagger behavior for overlapping updates within one query", () => {
    expect(shouldResetStaggeredLogs(
      [log("p3"), log("p2")],
      [log("new"), log("p3"), log("p2")],
      "all",
      "all"
    )).toBe(false);
  });
});

function log(requestId: string): RequestLogEntry {
  return { request_id: requestId } as RequestLogEntry;
}
