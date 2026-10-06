import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import { DashboardRecentRequests } from "../src/ui/dashboard/DashboardRecentRequests.js";
import { LogRowCells } from "../src/ui/logs/LogRowCells.js";
import { LogsPage } from "../src/ui/logs/LogsPage.js";
import { LogDetailPanel } from "../src/ui/logs/LogDetailRow.js";
import { LogTokenSummary } from "../src/ui/logs/LogSummary.js";
import { formatDurationMs } from "../src/ui/shared/format.js";
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

describe("request details", () => {
  it("puts failure evidence first and keeps transport metadata in a native disclosure", () => {
    const markup = renderToStaticMarkup(<LogDetailPanel entry={{ ...requestLog("present"),
      status: 200, stream_outcome: "upstream_http_error", error_summary: "Synthetic failure",
      upstream_status: 502, stream_terminal_event: "response.failed", client_disconnect_phase: "none",
      stream_oversized_event_count: 2, upstream_response_truncated: true,
      request_summary: "synthetic request context", user_agent: "synthetic-agent"
    }} onCollapse={() => {}} />);
    expect(markup.indexOf('aria-label="错误信息"')).toBeLessThan(markup.indexOf('aria-label="路由与模型"'));
    expect(markup).toContain("Synthetic failure");
    expect(markup).toContain("收起详情");
    const diagnostics = markup.match(/<details class="log-detail-diagnostics">(.*?)<\/details>/)?.[1];
    expect(diagnostics).toBeDefined();
    for (const text of ["开始时间", "完成时间", "502", "response.failed", "none", "upstream_http_error",
      "超大流事件", "已截断", "synthetic request context", "synthetic-agent"]) expect(diagnostics).toContain(text);
    expect(markup).toContain("查看抓包");
  });

  it("retains missing values and reports stream failures without an error summary", () => {
    const entry = requestLog("none");
    const normal = renderToStaticMarkup(<LogDetailPanel entry={entry} />);
    expect(normal).not.toContain('aria-label="错误信息"');
    expect(normal).toContain("本次请求没有抓包");
    expect(normal).toContain('<dt>缓存输出</dt><dd>-</dd>');
    expect(normal).toContain("首响应（首个数据块）");
    expect(normal).toContain("包含等待，非纯生成速度");
    const failure = renderToStaticMarkup(<LogDetailPanel entry={{ ...entry, stream_outcome: "success", stream_terminal_event: "response.incomplete" }} />);
    expect(failure).toContain('aria-label="错误信息"');
    expect(failure).toContain("response.incomplete");
  });

  it("preserves additive cache accounting and distinguishes inferred from declared models", () => {
    const markup = renderToStaticMarkup(<LogDetailPanel entry={{ ...requestLog("purged"),
      source_model: "source", target_model: "target", response_model: null,
      response_model_source: "target_fallback", effective_response_model: "target",
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 30,
      cached_input_tokens: 230, additive_cached_input_tokens: true, total_tokens: 380
    }} />);
    for (const [label, value] of [["输入", "130"], ["输出", "50"], ["缓存读取", "200"], ["缓存写入", "30"],
      ["缓存合计", "230"], ["总输入", "330"], ["原始总量", "380"]]) {
      expect(markup).toContain(`<dt>${label}</dt><dd>${value}</dd>`);
    }
    expect(markup).toContain("目标模型推断");
    expect(markup).toContain("未声明");
    expect(markup).not.toContain("响应声明不同");
  });
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

it("shows only the status code while keeping HTTP and stream errors accessible", () => {
  for (const showAllColumns of [true, false]) {
    for (const [status, stream_outcome, tone] of [[502, "upstream_http_error", "is-err"],
      [200, "upstream_http_error", "is-err"], [200, "success", "is-ok"]] as const) {
      const markup = renderToStaticMarkup(<table><tbody><tr><LogRowCells
        entry={{ ...requestLog("none"), status, stream_outcome }} showAllColumns={showAllColumns}
      /></tr></tbody></table>);
      const statusCell = [...markup.matchAll(/<td>(.*?)<\/td>/g)][1][1];
      expect(statusCell).toBe(`<span class="log-status ${tone}">${status}</span>${tone === "is-err" ? '<span class="visually-hidden"> 请求异常</span>' : ""}`);
    }
  }
});

it("groups cache rate with the total, retaining zero and hiding unavailable rates", () => {
  const render = (entry: RequestLogEntry) => renderToStaticMarkup(<LogTokenSummary entry={entry} />);
  const entry = { ...requestLog("none"), input_tokens: 1000, output_tokens: 100, cached_input_tokens: 300 };
  expect(render(entry)).toContain('<span class="log-token-head"><span class="token-total-pill">1.1K</span><small class="log-cache-rate"');
  expect(render(entry)).toContain('<span class="visually-hidden">缓存命中率 </span>30%</small></span><small class="log-token-breakdown">');
  expect(render({ ...entry, cached_input_tokens: 0 })).toContain('</span>0%</small>');
  expect(render(requestLog("none"))).not.toContain("log-cache-rate");
  expect(render({ ...entry, input_tokens: 100, cached_input_tokens: 230, cache_read_input_tokens: 200,
    cache_creation_input_tokens: 30, additive_cached_input_tokens: true })).toContain('</span>60.6%</small>');
});

it("defaults to the original twelve columns with separate first-response and duration fields", () => {
  const markup = renderToStaticMarkup(<LogsPage
    logs={[requestLog("none")]} logCounts={{ all: 1, primary: 1, compact: 0, claude: 0 }}
    providerCounts={{ all: 1, openai: 1, claude: 0 }} statusCounts={{ all: 1, normal: 1, error: 0 }}
    totalLogCount={1} allLogCount={1} hostOptions={[]} hasMoreLogs={false}
    isLoadingLogs={false} isLoadingMoreLogs={false} hasStaleLogs={false}
    routeFilter="all" statusFilter="all" hostFilter="__all_hosts__" searchFilter="" error={null}
    onDrilldownChange={() => {}} onRouteFilterChange={() => {}} onStatusFilterChange={() => {}}
    onHostFilterChange={() => {}} onSearchFilterChange={() => {}} onLoadMore={() => {}} onRetryLogs={() => {}}
    onOpenSamples={() => {}}
  />);
  expect([...markup.matchAll(/<th scope="col">(.*?)<\/th>/g)].map((match) => match[1])).toEqual([
    "开始时间", "状态", "模型 / 通道", "思考", "响应模型", "上游 Host",
    "上游凭据", "端点", "类型 / 吞吐", "Token", "首响应", "耗时"
  ]);
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain("精简列");
});

it("retains responsive model diagnostics and groups throughput with transport", () => {
  const entry = { ...requestLog("none"), response_model: "declared-other", target_model: "target",
    response_model_source: "upstream" as const, output_tokens: 50, duration_ms: 2000, first_token_ms: 120 };
  const render = (value: RequestLogEntry) => renderToStaticMarkup(<table><tbody><tr>
    <LogRowCells entry={value} showAllColumns />
  </tr></tbody></table>);
  const markup = render(entry);
  const cells = [...markup.matchAll(/<td>(.*?)<\/td>/g)].map((match) => match[1]);
  expect(cells).toHaveLength(12);
  expect(cells[2]).toContain("→ target");
  expect(cells[2]).toContain('<small class="log-model-response log-model-difference">↳ declared-other · 响应声明不同</small>');
  expect(cells[4]).toContain("declared-other");
  expect(cells[8]).toContain("stream");
  expect(cells[8]).toContain("25 tok/s");
  expect(cells[10]).toContain(formatDurationMs(120));
  expect(cells[11]).toContain(formatDurationMs(2000));
  const inferred = render({ ...entry, response_model: null, response_model_source: "target_fallback" });
  expect(inferred).toContain("目标模型推断");
  expect(inferred).not.toContain("响应声明不同");
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
