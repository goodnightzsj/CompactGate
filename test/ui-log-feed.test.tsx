import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RequestLogEntry, RequestLogPage } from "../src/shared/types.js";
import type { StudioLogEvent, HealthResponse } from "../src/shared/types.js";
import { mergeCodexStatusIntoHealth } from "../src/ui/hooks/useLogFeed.js";
import { LogsPage } from "../src/ui/logs/LogsPage.js";
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

describe("log request generations", () => {
  it("rejects stale pagination responses after the applied query changes", () => {
    expect(isCurrentLogRequest(1, 2, 4, 5)).toBe(false);
    expect(isCurrentLogRequest(2, 2, 4, 5)).toBe(false);
    expect(isCurrentLogRequest(2, 2, 5, 5)).toBe(true);
  });

  it("uses every applied filter in the page query key", () => {
    const base = { route: "all" as const, status: "all" as const, host: ALL_HOSTS_FILTER, limit: 200 };
    expect(logPageQueryKey(base)).not.toBe(logPageQueryKey({ ...base, route: "compact" }));
    expect(logPageQueryKey(base)).not.toBe(logPageQueryKey({ ...base, host: "other.example" }));
  });

  it("rejects responses whose query no longer matches the applied page", () => {
    const previous = { route: "all" as const, status: "all" as const, host: ALL_HOSTS_FILTER, limit: 200 };
    const current = { ...previous, route: "compact" as const };

    expect(isCurrentLogPageRequest(3, 3, previous, current)).toBe(false);
    expect(isCurrentLogPageRequest(3, 3, current, current, 7, 7)).toBe(true);
    expect(isCurrentLogPageRequest(3, 3, current, current, 6, 7)).toBe(false);
  });
});

describe("live log page updates", () => {
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
      "insert"
    );
    const afterUpdate = mergeLiveLogPage(
      afterInsert,
      { ...pending, capture_status: "present" },
      "primary",
      "all",
      ALL_HOSTS_FILTER,
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
      ALL_HOSTS_FILTER
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
  it("renders every loaded row instead of hiding rows after the first 100", () => {
    const logs = Array.from({ length: 120 }, (_, index) =>
      requestLog(`request-${String(index).padStart(3, "0")}`)
    );
    const markup = renderToStaticMarkup(
      <LogsPage
        logs={logs}
        logCounts={{ all: 120, primary: 120, compact: 0, claude: 0 }}
        providerCounts={{ all: 120, openai: 120, claude: 0 }}
        statusCounts={{ all: 120, normal: 120, error: 0 }}
        totalLogCount={120}
        allLogCount={120}
        hostOptions={[
          { host: "upstream.example", total: 120, primary: 120, compact: 0, claude: 0 }
        ]}
        hasMoreLogs={false}
        isLoadingLogs={false}
        isLoadingMoreLogs={false}
        routeFilter="all"
        statusFilter="all"
        hostFilter={ALL_HOSTS_FILTER}
        onRouteFilterChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onHostFilterChange={() => undefined}
        onLoadMore={() => undefined}
        error={null}
      />
    );

    expect(markup).toContain("显示 120 / 共 120 条");
    expect(markup.match(/class="log-row is-clickable/g)).toHaveLength(120);
  });
});

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
    request_id: requestId,
    error_summary: null,
    capture_path: null,
    capture_status: "none",
    ...overrides
  };
}
