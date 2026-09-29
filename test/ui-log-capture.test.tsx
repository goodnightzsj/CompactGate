import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import { DashboardRecentRequests } from "../src/ui/dashboard/DashboardRecentRequests.js";
import { LogRowCells } from "../src/ui/logs/LogRowCells.js";
import {
  CaptureRequestError,
  captureDownloadUrl,
  fetchCaptureRecord
} from "../src/ui/logs/capture-client.js";
import {
  CaptureDiffPanel,
  LogCaptureViewer
} from "../src/ui/logs/LogCaptureViewer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps essential log cells aligned and restores every diagnostic column", () => {
  const entry = requestLog("none");
  entry.key_name = "synthetic-key-label";
  const render = (showAllColumns: boolean) => renderToStaticMarkup(<table><tbody><tr>
    <LogRowCells entry={entry} showAllColumns={showAllColumns} />
  </tr></tbody></table>);
  expect(render(false).match(/<td>/g)).toHaveLength(7);
  expect(render(true).match(/<td>/g)).toHaveLength(12);
  expect(render(false)).toContain("上游凭据 · synthetic-key-label");
  expect(render(true)).toContain("synthetic-key-label");
});

it("keeps response evidence, token breakdown and throughput in both log summaries", async () => {
  const { LogMobileCard } = await import("../src/ui/logs/LogMobileCard.js");
  const entry = { ...requestLog("none"), response_model: "declared-other", target_model: "target",
    input_tokens: 100, output_tokens: 50, duration_ms: 2000 };
  const desktop = renderToStaticMarkup(<table><tbody><tr><LogRowCells entry={entry} showAllColumns={false} /></tr></tbody></table>);
  const mobile = renderToStaticMarkup(<LogMobileCard entry={entry} logKey="test" detailId="detail-test" expanded={false} onToggle={() => {}} />);
  for (const markup of [desktop, mobile]) {
    expect(markup).toContain("响应声明不同");
    expect(markup).toContain("declared-other");
    expect(markup).toContain("25 tok/s");
    expect(markup).toContain("入 ");
    expect(markup).toContain(" · 出 ");
  }
});

it("offers one keyboard entry per recent request with full metadata and instructions", () => {
  const entry = requestLog("none");
  entry.source_model = "long-model-".repeat(20);
  entry.upstream_host = "long-host-".repeat(20);
  entry.endpoint = "/long-endpoint".repeat(20);
    const markup = renderToStaticMarkup(<DashboardRecentRequests logs={[entry]} totalCount={1} listen="127.0.0.1:7865" />);
  expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
  expect(markup).toMatch(/<tr[^>]*aria-expanded="false"[^>]*aria-describedby=/);
  expect(markup).toContain("Enter / 空格查看完整信息");
  for (const value of [entry.source_model, entry.upstream_host, entry.endpoint]) expect(markup).toContain(value);
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

  it("renders bounded structural diff states", () => {
    const equivalent = renderToStaticMarkup(
      <CaptureDiffPanel
        id="equivalent"
        diff={{
          available: true,
          equivalent: true,
          reason: "transparent",
          entries: [],
          truncated: false
        }}
      />
    );
    const unavailable = renderToStaticMarkup(
      <CaptureDiffPanel
        id="unavailable"
        diff={{
          available: false,
          equivalent: false,
          reason: "truncated",
          entries: [],
          truncated: false
        }}
      />
    );
    const changed = renderToStaticMarkup(
      <CaptureDiffPanel
        id="changed"
        diff={{
          available: true,
          equivalent: false,
          reason: "diff_limit",
          entries: [{
            path: "$.model",
            kind: "changed",
            before: "\"old\"",
            after: "\"new\""
          }],
          truncated: true
        }}
      />
    );

    expect(equivalent).toContain("透明转发");
    expect(unavailable).toContain("正文已截断");
    expect(changed).toContain("$.model");
    expect(changed).toContain("已达到 Diff 上限");
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
    key_name: null,
    request_id: "request-id",
    error_summary: null,
    capture_path: null,
    capture_status: captureStatus
  };
}
