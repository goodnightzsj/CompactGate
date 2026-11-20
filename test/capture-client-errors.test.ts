import { afterEach, expect, it, vi } from "vitest";
import { CaptureRequestError, fetchCaptureRecord } from "../src/ui/logs/capture-client.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not turn a malformed successful capture into a loaded null record", async () => {
  for (const body of ["{broken", "null", "[]"]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(body)));
    await expect(fetchCaptureRecord("synthetic/id")).rejects.toBeInstanceOf(Error);
  }
});

it.each([200, 410])("preserves cancellation and body-read failures at HTTP %s", async (status) => {
  for (const error of [new DOMException("Synthetic cancelled", "AbortError"), new TypeError("Synthetic body read failure")]) {
    const response = new Response("{}", { status });
    vi.spyOn(response, "json").mockRejectedValueOnce(error);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response));
    await expect(fetchCaptureRecord("synthetic/id")).rejects.toBe(error);
  }
});

it("retains non-200 lifecycle errors even if the error response is not JSON", async () => {
  for (const status of [202, 404, 410, 500]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("<html>Synthetic unavailable</html>", { status, statusText: "Synthetic HTTP error" })));
    const error = await fetchCaptureRecord("synthetic/id").catch(error => error);
    expect(error).toBeInstanceOf(CaptureRequestError);
    expect(error).toMatchObject({ status, captureStatus: null, message: "Synthetic HTTP error" });
  }
});
