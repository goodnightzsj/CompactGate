import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import {
  CaptureRequestError,
  captureDownloadUrl,
  fetchCaptureRecord
} from "../src/ui/logs/capture-client.js";
import { LogCaptureViewer } from "../src/ui/logs/LogCaptureViewer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("capture client", () => {
  it("preserves HTTP and capture lifecycle status on API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Capture has been purged",
            capture_status: "purged"
          }),
          {
            status: 410,
            headers: { "content-type": "application/json" }
          }
        )
      )
    );

    const error = await fetchCaptureRecord("request-id").catch((reason) => reason);
    expect(error).toBeInstanceOf(CaptureRequestError);
    expect(error).toMatchObject({
      status: 410,
      captureStatus: "purged",
      message: "Capture has been purged"
    });
    expect(captureDownloadUrl("request/id")).toBe(
      "/api/logs/request%2Fid/capture/download"
    );
  });
});

describe("LogCaptureViewer", () => {
  it.each([
    ["none", "本次请求没有抓包"],
    ["pending", "抓包仍在写入"],
    ["present", "查看抓包"],
    ["purged", "原始文件已清理"]
  ] as const)("renders %s lifecycle guidance", (captureStatus, expectedText) => {
    const markup = renderToStaticMarkup(
      <LogCaptureViewer entry={requestLog(captureStatus)} />
    );

    expect(markup).toContain(expectedText);
    expect(markup).toContain("SQLite 仅元数据");
  });
});

function requestLog(
  captureStatus: RequestLogEntry["capture_status"]
): RequestLogEntry {
  return {
    time: "2026-07-15T00:00:00.000Z",
    completed_at: "2026-07-15T00:00:01.000Z",
    route: "primary",
    method: "POST",
    path: "/v1/responses",
    endpoint: "/responses",
    request_type: "stream",
    reasoning_effort: null,
    request_summary: null,
    incoming_request_body: null,
    upstream_request_body: null,
    upstream_response_body: null,
    client_response_body: null,
    body_status: "none",
    compact_response_normalized: false,
    compact_response_normalize_reason: null,
    compact_response_synthetic_source: null,
    source_model: "gpt-test",
    target_model: "gpt-test",
    response_model: "gpt-test",
    status: 200,
    duration_ms: 1,
    first_token_ms: null,
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    cached_output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    reasoning_tokens: null,
    additive_cached_input_tokens: false,
    additive_cached_output_tokens: false,
    total_tokens: null,
    upstream_host: "upstream.example",
    user_agent: null,
    request_id: "request-id",
    error_summary: null,
    capture_path: null,
    capture_status: captureStatus
  };
}
