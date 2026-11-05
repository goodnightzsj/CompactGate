import { describe, expect, it } from "vitest";
import { parseRetryAfterMs, rateLimitCooldownMs } from "../src/server/primary-failover-result.js";

describe("upstream retry delay headers", () => {
  const now = Date.UTC(2026, 10, 5);
  it.each([
    [{ "retry-after-ms": "1250", "retry-after": "5" }, 1250],
    [{ "retry-after-ms": "0", "retry-after": "5" }, 0],
    [{ "retry-after-ms": "broken", "retry-after": "1.5" }, 1500],
    [{ "retry-after-ms": "-2", "retry-after": "2" }, 2000],
    [{ "retry-after": "0.25" }, 250],
    [{ "retry-after": new Date(now + 4000).toUTCString() }, 4000],
    [{ "retry-after-ms": "Infinity" }, null],
    [{ "retry-after-ms": "2oops" }, null]
  ])("parses %j", (headers, expected) => expect(parseRetryAfterMs(headers, now)).toBe(expected));
  it("shares millisecond timing with account cooldown and retains its cap", () => {
    expect(rateLimitCooldownMs({ status: 429, errorSummary: "rate limit", responseHeaders: { "retry-after-ms": "1250" } }, 1, now)).toBe(1250);
    expect(rateLimitCooldownMs({ status: 429, errorSummary: "rate limit", responseHeaders: { "retry-after-ms": "3600000" } }, 1, now)).toBe(600000);
  });
});
