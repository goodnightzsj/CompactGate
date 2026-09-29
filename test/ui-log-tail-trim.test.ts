import { describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import { isLogTailTrim } from "../src/ui/logs/useStaggeredLogs.js";

describe("log maintenance layout invalidation", () => {
  const logs = ["new", "middle", "old"].map((request_id) => ({
    request_id, time: "2026-09-28T00:00:00Z", status: 200
  } as RequestLogEntry));

  it("skips unchanged prefix groups only for a strict tail trim", () => {
    expect(isLogTailTrim(logs, logs.slice(0, 2))).toBe(true);
    expect(isLogTailTrim(logs, structuredClone(logs.slice(0, 2)))).toBe(true);
    expect(isLogTailTrim(logs, [])).toBe(true);
  });

  it("keeps measurement for head/middle exits, reorder, updates and inserts", () => {
    for (const next of [
      logs, structuredClone(logs), logs.slice(1), [logs[0], logs[2]],
      [logs[1], logs[0]], [...logs, logs[0]],
      [{ ...logs[0], status: 201 }, logs[1]],
      [{ ...logs[0], key_name: "adds a mobile line" }, logs[1]],
      [{ ...logs[0], time: "2026-09-28T00:00:01Z" }, logs[1]]
    ]) expect(isLogTailTrim(logs, next)).toBe(false);
    expect(isLogTailTrim([], [])).toBe(false);
  });
});
