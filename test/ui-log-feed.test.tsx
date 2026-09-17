import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RequestLogEntry, RequestLogPage } from "../src/shared/types.js";
import type { StudioLogEvent, HealthResponse } from "../src/shared/types.js";
import { fetchPendingLogPage, fetchMoreLogPage, mergeCodexStatusIntoHealth } from "../src/ui/hooks/useLogFeed.js";
import { LogsPage } from "../src/ui/logs/LogsPage.js";
import { DashboardRecentRequests } from "../src/ui/dashboard/DashboardRecentRequests.js";
import { useNarrowViewport } from "../src/ui/logs/useNarrowViewport.js";
import {
  ALL_HOSTS_FILTER,
  mergeLiveLogPage,
  replayLiveLogEvents
} from "../src/ui/logs/log-utils.js";
import {
  isCurrentLogPageRequest,
  isCurrentLogRequest,
  logPageQueryKey
} from "../src/ui/logs/log-feed-query.js";

vi.mock("../src/ui/logs/useNarrowViewport.js", () => ({
  useNarrowViewport: vi.fn(() => false),
  useMediaQuery: vi.fn(() => false)
}));

describe("log request generations", () => {
  it("rejects stale pagination responses after the applied query changes", () => {
    expect(isCurrentLogRequest(1, 2, 4, 5)).toBe(false);
    expect(isCurrentLogRequest(2, 2, 4, 5)).toBe(false);
    expect(isCurrentLogRequest(2, 2, 5, 5)).toBe(true);
  });

  it("uses every applied filter in the page query key", () => {
    const base = { route: "all" as const, status: "all" as const, host: ALL_HOSTS_FILTER, search: "", limit: 200 };
    expect(logPageQueryKey(base)).not.toBe(logPageQueryKey({ ...base, route: "compact" }));
    expect(logPageQueryKey(base)).not.toBe(logPageQueryKey({ ...base, host: "other.example" }));
    expect(logPageQueryKey(base)).not.toBe(logPageQueryKey({ ...base, search: "gpt-5" }));
  });

  it("rejects responses whose query no longer matches the applied page", () => {
    const previous = { route: "all" as const, status: "all" as const, host: ALL_HOSTS_FILTER, search: "", limit: 200 };
    const current = { ...previous, route: "compact" as const };

    expect(isCurrentLogPageRequest(3, 3, previous, current)).toBe(false);
    expect(isCurrentLogPageRequest(3, 3, current, current, 7, 7)).toBe(true);
    expect(isCurrentLogPageRequest(3, 3, current, current, 6, 7)).toBe(false);
  });
});

describe("live log page updates", () => {
  it.each([false, true])("preserves a continuous window when an insert crosses pagination (already counted=%s)", async (alreadyCounted) => {
    const row = (id: number) => requestLog(String(id), { sequence: id });
    const baseline = { ...emptyPage(2), logs: [row(4), row(3)], latest_sequence: 4, total: 4, all_total: 4, has_more: true };
    const pending: Parameters<typeof fetchPendingLogPage>[0] = {
      generation: 1, query: { route: "all", status: "all", host: ALL_HOSTS_FILTER, search: "", limit: 2 },
      liveEvents: [], snapshot: null
    };
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      pending.liveEvents.push({ operation: "insert", entry: row(5) });
      return new Response(JSON.stringify({ ...baseline, offset: 2,
        logs: alreadyCounted ? [row(3), row(2)] : [row(2), row(1)],
        latest_sequence: alreadyCounted ? 5 : 4, total: alreadyCounted ? 5 : 4, all_total: alreadyCounted ? 5 : 4 }));
    });
    try {
      const result = await fetchMoreLogPage(pending, baseline, () => true);
      expect(result.logs.map((entry) => entry.request_id)).toEqual(["5", "4", "3", "2"]);
      expect(result).toMatchObject({ total: 5, all_total: 5, has_more: true, limit: 2, offset: 0 });
    } finally { fetcher.mockRestore(); }
  });

  it("does not double-count an invisible insert already in a filtered snapshot", () => {
    const page = { ...emptyPage(2), latest_sequence: 2, logs: [requestLog("primary", { sequence: 1 })],
      total: 1, all_total: 2, counts: { all: 2, primary: 1, compact: 1, claude: 0 } };
    const result = replayLiveLogEvents(page,
      [{ operation: "insert", entry: requestLog("compact", { route: "compact", sequence: 2 }) }],
      "primary", "all", ALL_HOSTS_FILTER, "");
    expect(result.all_total).toBe(2);
    expect(result.counts.compact).toBe(1);
  });

  it("restarts from a contiguous first page when rows are deleted during pagination", async () => {
    const baseline = { ...emptyPage(2), logs: [requestLog("4"), requestLog("3")], total: 4, has_more: true };
    const remaining = { ...emptyPage(2), logs: [requestLog("4")], total: 1, all_total: 1 };
    const pending: Parameters<typeof fetchPendingLogPage>[0] = {
      generation: 1, query: { route: "primary", status: "all", host: ALL_HOSTS_FILTER, search: "", limit: 2 },
      liveEvents: [], snapshot: null
    };
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        pending.snapshot = remaining;
        return new Response(JSON.stringify({ ...baseline, offset: 2, logs: [requestLog("2"), requestLog("1")] }));
      })
      .mockImplementationOnce(async () => {
        pending.liveEvents.push({ operation: "update", entry: requestLog("4", { capture_status: "present" }) });
        return new Response(JSON.stringify(remaining));
      });
    try {
      const result = await fetchMoreLogPage(pending, baseline, () => true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(String(fetcher.mock.calls[1][0])).toContain("offset=0");
      expect(result.logs.map((entry) => entry.request_id)).toEqual(["4"]);
      expect(result.logs[0].capture_status).toBe("present");
      expect(result).toMatchObject({ total: 1, all_total: 1, has_more: false });
    } finally { fetcher.mockRestore(); }
  });

  it.each([false, true])("re-queries an interleaved snapshot without mixing page windows (newer snapshot=%s)", async (newerSnapshot) => {
    const oldPage = { ...emptyPage(2), logs: [requestLog("3"), requestLog("2")], total: 3, all_total: 3, has_more: true };
    const newPage = { ...oldPage, logs: [requestLog("4"), requestLog("3")], total: 4, all_total: 4 };
    const pending: Parameters<typeof fetchPendingLogPage>[0] = {
      generation: 1,
      query: { route: "all", status: "all", host: ALL_HOSTS_FILTER, search: "", limit: 2 },
      liveEvents: [], snapshot: null
    };
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        pending.snapshot = newerSnapshot ? newPage : oldPage;
        pending.liveEvents.push({ operation: "insert", entry: requestLog("4") });
        return new Response(JSON.stringify(newerSnapshot ? oldPage : newPage));
      })
      .mockImplementationOnce(async () => {
        pending.liveEvents.push({ operation: "update", entry: requestLog("4", { capture_status: "present" }) });
        return new Response(JSON.stringify(newPage));
      });
    try {
      const result = await fetchPendingLogPage(pending, () => true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result.logs.map((entry) => entry.request_id)).toEqual(["4", "3"]);
      expect(result.logs[0].capture_status).toBe("present");
      expect(result).toMatchObject({ total: 4, all_total: 4, has_more: true, offset: 0 });
    } finally {
      fetcher.mockRestore();
    }
  });

  it("does not re-query a pending load that lost its generation", async () => {
    const pending: Parameters<typeof fetchPendingLogPage>[0] = {
      generation: 1, query: { route: "all", status: "all", host: ALL_HOSTS_FILTER, search: "", limit: 2 },
      liveEvents: [], snapshot: null
    };
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      pending.snapshot = emptyPage(2);
      return new Response(JSON.stringify(emptyPage(2)));
    });
    try {
      await fetchPendingLogPage(pending, () => false);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("projects compact event protocol status into the current health snapshot", () => {
    const health = { codex: { observed_protocol: "remote_v1" } } as HealthResponse;
    const event = {
      operation: "insert",
      entry: requestLog("compact-live", { compaction_mode: "remote_v2" }),
      codex_status: { observed_protocol: "remote_v2" }
    } as StudioLogEvent;

    expect(mergeCodexStatusIntoHealth(health, event)?.codex.observed_protocol).toBe("remote_v2");
    expect(mergeCodexStatusIntoHealth(health, { operation: "insert", entry: requestLog("ordinary") }))
      .toBe(health);
  });

  it("does not increment filtered counts for capture lifecycle updates", () => {
    const initial = emptyPage(2);
    const pending = requestLog("capture-update", {
      route: "compact",
      capture_status: "pending"
    });
    const afterInsert = mergeLiveLogPage(
      initial,
      pending,
      "primary",
      "all",
      ALL_HOSTS_FILTER,
      "",
      "insert"
    );
    const afterUpdate = mergeLiveLogPage(
      afterInsert,
      { ...pending, capture_status: "present" },
      "primary",
      "all",
      ALL_HOSTS_FILTER,
      "",
      "update"
    );

    expect(afterUpdate.logs).toEqual([]);
    expect(afterUpdate.all_total).toBe(1);
    expect(afterUpdate.counts).toEqual({
      all: 1,
      primary: 0,
      compact: 1,
      claude: 0
    });
    expect(afterUpdate.provider_counts).toEqual({
      all: 1,
      openai: 1,
      claude: 0
    });
  });

  it("keeps live inserts within the already loaded window", () => {
    const first = requestLog("request-2");
    const second = requestLog("request-1");
    const initial: RequestLogPage = {
      ...emptyPage(2),
      logs: [first, second],
      total: 10,
      all_total: 10,
      has_more: true,
      counts: { all: 10, primary: 10, compact: 0, claude: 0 },
      provider_counts: { all: 10, openai: 10, claude: 0 },
      status_counts: { all: 10, normal: 10, error: 0 },
      host_counts: [{ host: "upstream.example", total: 10, primary: 10, compact: 0, claude: 0 }]
    };

    const updated = mergeLiveLogPage(
      initial,
      requestLog("request-3"),
      "all",
      "all",
      ALL_HOSTS_FILTER,
      "",
      "insert"
    );

    expect(updated.logs.map((entry) => entry.request_id)).toEqual([
      "request-3",
      "request-2"
    ]);
    expect(updated.logs).toHaveLength(2);
    expect(updated.total).toBe(11);
    expect(updated.has_more).toBe(true);
  });

  it("replays live events that arrive while the first page is loading", () => {
    const existing = requestLog("request-existing", { capture_status: "pending" });
    const initial: RequestLogPage = {
      ...emptyPage(2),
      logs: [existing],
      total: 1,
      all_total: 1,
      counts: { all: 1, primary: 1, compact: 0, claude: 0 },
      provider_counts: { all: 1, openai: 1, claude: 0 },
      status_counts: { all: 1, normal: 1, error: 0 },
      host_counts: [{ host: "upstream.example", total: 1, primary: 1, compact: 0, claude: 0 }]
    };

    const replayed = replayLiveLogEvents(
      initial,
      [
        { operation: "insert", entry: requestLog("request-live") },
        { operation: "update", entry: { ...existing, capture_status: "present" } }
      ],
      "all",
      "all",
      ALL_HOSTS_FILTER,
      ""
    );

    expect(replayed.logs.map((entry) => entry.request_id)).toEqual([
      "request-live",
      "request-existing"
    ]);
    expect(replayed.logs[1].capture_status).toBe("present");
    expect(replayed.total).toBe(2);
  });
});

describe("LogsPage loaded rows", () => {
  it.each([false, true])("uses the dashboard's CSS breakpoint with one mounted view (narrow=%s)", (narrow) => {
    vi.mocked(useNarrowViewport).mockReturnValueOnce(narrow);
    const markup = renderToStaticMarkup(<DashboardRecentRequests logs={[requestLog("recent")]} listen="127.0.0.1:0" />);
    expect(useNarrowViewport).toHaveBeenLastCalledWith("(max-width: 760px)");
    expect(markup.includes("dashboard-request-table")).toBe(!narrow);
    expect(markup.includes("dashboard-request-list")).toBe(narrow);
  });

  it.each(["all", "error"] as const)("keeps failed refresh context visible and blocks stale pagination (status=%s)", (statusFilter) => {
    const markup = renderLogsPage([requestLog("previous-result")], {
      statusFilter, hasStaleLogs: true, hasMoreLogs: true, error: "Synthetic refresh failure"
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("当前结果尚未更新，下面保留上次成功加载的结果。");
    expect(markup).toContain("上次结果 · ");
    expect(markup).toContain("重试日志");
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>加载更早日志/);
    expect(markup).toContain('data-log-id="previous-result"');
  });

  it("does not present a failed empty query as a successful no-results search", () => {
    const markup = renderLogsPage([], { statusFilter: "error", hasStaleLogs: true, error: "Synthetic query failure" });
    expect(markup).toContain("尚无可显示的日志");
    expect(markup).not.toContain("当前筛选条件下无记录");
    expect(markup).toContain("重试日志");
  });

  it.each([false, true])("announces loading without clearing old results when narrow=%s", (narrow) => {
    vi.mocked(useNarrowViewport).mockReturnValueOnce(narrow);
    const markup = renderLogsPage([requestLog("previous-result")], { isLoadingLogs: true, hasStaleLogs: true });
    expect(markup).toContain("更新中 · ");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-log-id="previous-result"');
  });

  it.each([false, true])("collapses secondary filters only when narrow=%s", (narrow) => {
    vi.mocked(useNarrowViewport).mockReturnValueOnce(narrow);
    const markup = renderLogsPage([]);
    expect(markup.includes('class="logs-filter-options" open=""')).toBe(!narrow);
    expect(markup).toContain("通道 / 状态 / 上游");
    expect(markup).toContain('aria-label="搜索日志"');
    expect(markup).toContain("只看错误");
  });

  it.each([false, true])("mounts only the visible log tree when narrow=%s", (narrow) => {
    vi.mocked(useNarrowViewport).mockReturnValueOnce(narrow);
    const markup = renderLogsPage([requestLog("viewport-row")]);
    expect(markup.includes('class="log-table log-table-full"')).toBe(!narrow);
    expect(markup.includes('class="logs-mobile-list"')).toBe(narrow);
    expect(markup.match(/data-log-id="viewport-row"/g)).toHaveLength(1);
  });

  it("keeps the empty table shell mounted for the first live-row animation", () => {
    const markup = renderLogsPage([]);

    expect(markup).toContain("暂无请求记录");
    expect(markup).toContain('class="log-table log-table-full" hidden=""');
  });

  it("renders every loaded row instead of hiding rows after the first 100", () => {
    const logs = Array.from({ length: 120 }, (_, index) =>
      requestLog(`request-${String(index).padStart(3, "0")}`)
    );
    const markup = renderLogsPage(logs);

    expect(markup).toContain("显示 120 / 共 120 条");
    expect(markup.match(/class="log-row is-clickable/g)).toHaveLength(120);
  });
  it("shows a host total that agrees with the hosts listed under it", () => {
    // allLogCount is the whole-database row count, while the host rows come from
    // the filtered host facet. Using it for "全部上游" made the dropdown claim
    // more rows than the hosts beneath it add up to.
    const markup = renderToStaticMarkup(
      <LogsPage
        logs={[]}
        logCounts={{ all: 100, primary: 0, compact: 0, claude: 100 }}
        providerCounts={{ all: 100, openai: 0, claude: 100 }}
        statusCounts={{ all: 100, normal: 100, error: 0 }}
        totalLogCount={100}
        allLogCount={1000}
        hostOptions={[
          { host: "api.anthropic.com", total: 60, primary: 0, compact: 0, claude: 60 },
          { host: "relay.example", total: 40, primary: 0, compact: 0, claude: 40 }
        ]}
        hasMoreLogs={false}
        isLoadingLogs={false}
        isLoadingMoreLogs={false}
        hasStaleLogs={false}
        routeFilter="claude"
        statusFilter="all"
        hostFilter={ALL_HOSTS_FILTER}
        searchFilter=""
        onRouteFilterChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onHostFilterChange={() => undefined}
        onSearchFilterChange={() => undefined}
        onLoadMore={() => undefined}
        onRetryLogs={() => undefined}
        error={null}
      />
    );
    const hostSection = markup.slice(markup.indexOf("全部上游"));
    const shownTotal = /全部上游[\s\S]{0,200}?>(\d+)</.exec(hostSection)?.[1];

    expect(shownTotal).toBe("100");
    expect(markup).toContain("已存储 1000 条");
  });
});

function renderLogsPage(logs: RequestLogEntry[], overrides: Partial<ComponentProps<typeof LogsPage>> = {}): string {
  const total = logs.length;
  return renderToStaticMarkup(
    <LogsPage
      logs={logs}
      logCounts={{ all: total, primary: total, compact: 0, claude: 0 }}
      providerCounts={{ all: total, openai: total, claude: 0 }}
      statusCounts={{ all: total, normal: total, error: 0 }}
      totalLogCount={total}
      allLogCount={total}
      hostOptions={total === 0 ? [] : [
        { host: "upstream.example", total, primary: total, compact: 0, claude: 0 }
      ]}
      hasMoreLogs={false}
      isLoadingLogs={false}
      isLoadingMoreLogs={false}
      hasStaleLogs={false}
      routeFilter="all"
      statusFilter="all"
      hostFilter={ALL_HOSTS_FILTER}
      searchFilter=""
      onRouteFilterChange={() => undefined}
      onStatusFilterChange={() => undefined}
      onHostFilterChange={() => undefined}
      onSearchFilterChange={() => undefined}
      onLoadMore={() => undefined}
      onRetryLogs={() => undefined}
      error={null}
      {...overrides}
    />
  );
}

function emptyPage(limit: number): RequestLogPage {
  return {
    logs: [],
    limit,
    offset: 0,
    total: 0,
    all_total: 0,
    has_more: false,
    counts: { all: 0, primary: 0, compact: 0, claude: 0 },
    provider_counts: { all: 0, openai: 0, claude: 0 },
    status_counts: { all: 0, normal: 0, error: 0 },
    host_counts: []
  };
}

function requestLog(
  requestId: string,
  overrides: Partial<RequestLogEntry> = {}
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
    request_id: requestId,
    error_summary: null,
    capture_path: null,
    capture_status: "none",
    ...overrides
  };
}
