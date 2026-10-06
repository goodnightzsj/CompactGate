import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/ui/shared/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("studio API failure reporting", () => {
  it.each(["<html>unavailable</html>", ""])("retains HTTP status for a non-JSON failure", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 503, statusText: "Service Unavailable" })));
    await expect(api("/api/health")).rejects.toThrow("HTTP 503 Service Unavailable");
  });

  it("preserves existing JSON error messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Config patch was built from a superseded revision." }), { status: 409 })));
    await expect(api("/api/config")).rejects.toThrow(/^Config patch was built from a superseded revision\.$/);
  });

  it("still rejects invalid successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON")));
    await expect(api("/api/health")).rejects.toBeInstanceOf(SyntaxError);
  });

  it("preserves body-read cancellation instead of replacing it with an HTTP error", async () => {
    const aborted = new DOMException("Synthetic abort", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.reject(aborted) }));
    await expect(api("/api/health")).rejects.toBe(aborted);
  });
});
