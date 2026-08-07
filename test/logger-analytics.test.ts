import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RequestLogger } from "../src/server/logger.js";
import type { RequestLogEntry } from "../src/shared/types.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe("RequestLogger stats", () => {
  it("aggregates retained logs with the existing error, token, and model semantics", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-stats-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const logger = new RequestLogger(10, path.join(dir, "logs.sqlite"));

    try {
      logger.add(logEntry({
        time: "2026-08-07T00:15:00.000Z",
        request_id: "primary",
        route: "primary",
        source_model: "client-model",
        target_model: "routed-model",
        response_model: "upstream-model",
        response_model_source: "upstream",
        duration_ms: 101,
        first_token_ms: 51,
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 40,
        total_tokens: 120
      }));
      logger.add(logEntry({
        time: "2026-08-07T01:15:00.000Z",
        request_id: "error",
        route: "compact",
        path: "/responses",
        status: 500,
        upstream_status: 500,
        stream_outcome: "upstream_http_error",
        error_summary: "upstream failed",
        duration_ms: 200
      }));
      logger.add(logEntry({
        time: "2026-08-07T01:45:00.000Z",
        request_id: "claude",
        route: "claude",
        path: "/v1/messages?beta=true",
        endpoint: "/messages",
        target_model: "claude-target",
        response_model_source: "target_fallback",
        duration_ms: 300,
        first_token_ms: 100,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 20,
        reasoning_tokens: 3,
        additive_cached_input_tokens: true,
        total_tokens: 0
      }));
      logger.add(logEntry({
        time: "2026-08-07T02:00:00.000Z",
        request_id: "exclusive-boundary"
      }));

      const stats = logger.stats({
        from: "2026-08-07T00:00:00.000Z",
        to: "2026-08-07T02:00:00.000Z"
      });

      expect(stats.summary).toMatchObject({
        requests: 3,
        normal_requests: 2,
        error_requests: 1,
        usage_observed_requests: 2,
        input_tokens: 160,
        output_tokens: 25,
        cache_read_tokens: 70,
        cache_creation_tokens: 20,
        reasoning_tokens: 3,
        total_tokens: 185,
        average_duration_ms: 200.33333333333334,
        average_first_token_ms: 75.5,
        duration_p50_ms: 200,
        duration_p95_ms: 300,
        first_token_p50_ms: 51,
        first_token_p95_ms: 100
      });
      expect(stats.trend.map((point) => [
        point.bucket_start,
        point.requests,
        point.error_requests,
        point.total_tokens
      ])).toEqual([
        ["2026-08-07T00:00:00.000Z", 1, 0, 120],
        ["2026-08-07T01:00:00.000Z", 2, 1, 65]
      ]);
      expect(stats.by_route.map((row) => [row.route, row.requests])).toEqual([
        ["claude", 1],
        ["compact", 1],
        ["primary", 1]
      ]);
      expect(stats.by_model).toEqual(expect.arrayContaining([
        expect.objectContaining({
          model: "upstream-model",
          requests: 1,
          input_tokens: 100,
          cache_read_tokens: 40,
          total_tokens: 120
        }),
        expect.objectContaining({
          model: "claude-target",
          requests: 1,
          input_tokens: 60,
          cache_read_tokens: 30,
          total_tokens: 65
        })
      ]));
      expect(stats.by_endpoint).toEqual(expect.arrayContaining([
        expect.objectContaining({ endpoint: "/v1/responses", requests: 1 }),
        expect.objectContaining({ endpoint: "/responses", requests: 1 }),
        expect.objectContaining({ endpoint: "/v1/messages", requests: 1 })
      ]));
      expect(stats.model_mappings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_model: "client-model",
          target_model: "routed-model",
          response_model: "upstream-model",
          requests: 1
        })
      ]));
      expect(stats.retained_range).toEqual({
        oldest_at: "2026-08-07T00:15:00.000Z",
        newest_at: "2026-08-07T02:00:00.000Z"
      });
    } finally {
      logger.close();
    }
  });
});

function logEntry(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  const time = overrides.time ?? "2026-08-07T00:00:00.000Z";
  return {
    time,
    completed_at: time,
    route: "primary",
    compaction_mode: null,
    compaction_detection_source: null,
    method: "POST",
    path: "/v1/responses",
    endpoint: "/responses",
    request_type: "http",
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
    source_model: null,
    target_model: null,
    response_model: null,
    response_model_source: "unavailable",
    status: 200,
    upstream_status: 200,
    stream_terminal_event: null,
    client_disconnect_phase: "none",
    stream_outcome: "success",
    stream_oversized_event_count: 0,
    upstream_response_truncated: false,
    duration_ms: 10,
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
    request_id: "request",
    error_summary: null,
    capture_path: null,
    capture_status: "none",
    ...overrides
  };
}
