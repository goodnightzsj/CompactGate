import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RequestLogger } from "../src/server/logger.js";
import { createAnthropicStreamObserver, createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";
import { summarizeAnthropicStreamFailure, summarizeOpenAiStreamFailure } from "../src/server/upstream-client.js";
import type { RequestLogEntry } from "../src/shared/types.js";
import {
  logStatusKind,
  logStatusToneClass,
  responseModelDisplay,
  responseModelSourceLabel,
  compactionModeLabel,
  compactionDetectionLabel
} from "../src/ui/logs/log-utils.js";
import {
  cacheCreationInputTokens,
  displayInputTokens
} from "../src/ui/logs/log-token-metrics.js";

describe("UI log status helpers", () => {
  it("treats a 2xx response with only a diagnostic summary as an error", () => {
    const entry = requestLog({
      status: 200,
      error_summary: "OpenAI stream closed before response.completed."
    });

    expect(logStatusKind(entry)).toBe("error");
    expect(logStatusToneClass(entry)).toBe("is-err");
  });

  it("does not let token details mask an OpenAI stream failure", () => {
    const entry = requestLog({
      status: 200,
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      error_summary: "OpenAI stream ended with response.failed."
    });

    expect(logStatusKind(entry)).toBe("error");
    expect(logStatusToneClass(entry)).toBe("is-err");
  });

  it.each(["primary", "compact", "claude"] as const)("keeps %s failures red with missing, zero or positive usage", (route) => {
    for (const total_tokens of [null, 0, 16]) {
      for (const failure of [
        { status: 502 },
        { status: 200, error_summary: "OpenAI stream ended with response.failed." },
        { status: 200, stream_terminal_event: "response.failed" },
        { status: 200, stream_terminal_event: "response.incomplete" },
        { status: 200, stream_outcome: "upstream_stream_incomplete" as const }
      ]) {
        const entry = requestLog({ route, total_tokens, ...failure });
        expect(logStatusKind(entry)).toBe("error");
        expect(logStatusToneClass(entry)).toBe("is-err");
      }
    }
  });

  it.each(["response.failed", "response.incomplete"])("does not erase %s diagnostics when a DONE marker follows", async (terminal) => {
    const headers = { "content-type": "text/event-stream" };
    const observer = createOpenAiStreamObserver(headers)!;
    observer.observe(Buffer.from(`event: ${terminal}\ndata: {"type":"${terminal}"}\n\ndata: [DONE]\n\n`));
    expect(summarizeOpenAiStreamFailure({
      status: 200,
      errorSummary: null,
      responseBody: Buffer.alloc(0),
      responseBodyTruncated: false,
      responseHeaders: headers,
      firstTokenMs: null,
      streamSummary: await observer.finish(),
      clientDisconnectPhase: "none"
    })).toBe(`OpenAI stream ended with ${terminal}.`);
  });

  it("keeps UI, SQL filters, facets and analytics consistent across a stale facet rebuild", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-log-status-"));
    const dbPath = path.join(dir, "logs.sqlite");
    let logger: RequestLogger | undefined;
    try {
      logger = new RequestLogger(100, dbPath);
      const entries = [
        requestLog({ request_id: "failed-with-usage", total_tokens: 16, error_summary: "OpenAI stream ended with response.failed." }),
        requestLog({ request_id: "http-failed-with-usage", status: 502, total_tokens: 16 }),
        requestLog({ request_id: "failed-without-summary", stream_terminal_event: "response.failed", total_tokens: 0 }),
        requestLog({ request_id: "completed", stream_outcome: "success", stream_terminal_event: "response.completed", client_disconnect_phase: "after_terminal", total_tokens: 16 }),
        requestLog({ request_id: "empty-summary", error_summary: "" })
      ];
      entries.forEach((entry) => logger!.add(entry));
      const check = () => {
        expect(logger!.page({ limit: 100, offset: 0 }).status_counts).toEqual({ all: 5, normal: 2, error: 3 });
        for (const status of ["normal", "error"] as const) {
          for (const search of [undefined, "gpt-5.5"]) {
            // All rows share this model so the search path exercises raw SQL instead of facets.
            const page = logger!.page({ limit: 100, offset: 0, status, search });
            expect(page.total).toBe(status === "error" ? 3 : 2);
            expect(page.logs.every((entry) => logStatusKind(entry) === status)).toBe(true);
          }
        }
        expect(logger!.stats({ from: "2026-06-09T00:00:00.000Z", to: "2026-06-10T00:00:00.000Z" }).summary)
          .toMatchObject({ requests: 5, normal_requests: 2, error_requests: 3, total_tokens: 48 });
      };
      check();
      logger.close();
      logger = undefined;
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("DELETE FROM request_log_facets; INSERT INTO request_log_facets VALUES ('muyuan.do', 'primary', 'normal', 5); UPDATE request_log_internal_state SET value = '2' WHERE key = 'facet_classification_version';");
      } finally {
        db.close();
      }
      logger = new RequestLogger(100, dbPath);
      check();
      expect(logger.recent().find((entry) => entry.request_id === "http-failed-with-usage")?.status).toBe(502);
    } finally {
      logger?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not erase an Anthropic error when message_stop follows", async () => {
    const headers = { "content-type": "text/event-stream" };
    const observer = createAnthropicStreamObserver(headers)!;
    observer.observe(Buffer.from('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"synthetic failure"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'));
    expect(summarizeAnthropicStreamFailure({
      status: 200, errorSummary: null, responseBody: Buffer.alloc(0), responseBodyTruncated: false,
      responseHeaders: headers, firstTokenMs: null, streamSummary: await observer.finish(), clientDisconnectPhase: "none"
    })).toContain("synthetic failure");
  });

  it("does not let token details mask a Claude stream failure", () => {
    const entry = requestLog({
      route: "claude",
      status: 200,
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      stream_outcome: "upstream_stream_error",
      error_summary: "Overloaded (overloaded_error)"
    });

    expect(logStatusKind(entry)).toBe("error");
    expect(logStatusToneClass(entry)).toBe("is-err");
  });

  it("keeps clean 2xx responses in the normal status bucket", () => {
    const entry = requestLog({
      status: 200,
      error_summary: null
    });

    expect(logStatusKind(entry)).toBe("normal");
    expect(logStatusToneClass(entry)).toBe("is-ok");
  });

  it("treats only clean 2xx statuses as normal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-log-status-range-"));
    const dbPath = path.join(dir, "logs.sqlite");
    let logger: RequestLogger | undefined;
    try {
      logger = new RequestLogger(100, dbPath);
      const entries = [
        requestLog({ request_id: "status-199", status: 199 }),
        requestLog({ request_id: "status-200", status: 200 }),
        requestLog({ request_id: "status-204", status: 204 }),
        requestLog({ request_id: "status-300", status: 300 })
      ];
      entries.forEach((entry) => logger!.add(entry));

      expect(entries.map(logStatusKind)).toEqual(["error", "normal", "normal", "error"]);
      expect(logger.page({ limit: 100, offset: 0 }).status_counts).toEqual({
        all: 4,
        normal: 2,
        error: 2
      });
      expect(logger.page({ limit: 100, offset: 0, status: "normal" }).logs.map((entry) => entry.status).sort())
        .toEqual([200, 204]);
      expect(logger.page({ limit: 100, offset: 0, status: "error" }).logs.map((entry) => entry.status).sort())
        .toEqual([199, 300]);
    } finally {
      logger?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a completed stream followed by client close as normal", () => {
    const entry = requestLog({
      status: 200,
      stream_outcome: "success",
      client_disconnect_phase: "after_terminal",
      stream_terminal_event: "response.completed"
    });

    expect(logStatusKind(entry)).toBe("normal");
    expect(logStatusToneClass(entry)).toBe("is-ok");
  });

  it("shows a pre-terminal client cancellation as an error", () => {
    const entry = requestLog({
      status: 502,
      stream_outcome: "client_cancel",
      client_disconnect_phase: "before_terminal"
    });

    expect(logStatusKind(entry)).toBe("error");
    expect(logStatusToneClass(entry)).toBe("is-err");
  });

  it("uses the target model fallback for a response-model display value", () => {
    const entry = requestLog({
      response_model: null,
      response_model_source: "target_fallback",
      target_model: "gpt-5.6-sol"
    });

    expect(responseModelDisplay(entry)).toBe("gpt-5.6-sol");
    expect(responseModelSourceLabel(entry)).toBe("目标模型推断");
  });

  it("uses the neutral placeholder when a failed stream has no response model", () => {
    const entry = requestLog({
      response_model: null,
      response_model_source: "unavailable",
      stream_outcome: "upstream_stream_incomplete"
    });

    expect(responseModelDisplay(entry)).toBe("-");
    expect(responseModelSourceLabel(entry)).toBe("未获得");
  });

  it("prioritizes the backend effective model projection", () => {
    const entry = requestLog({
      effective_response_model: "gpt-5.6-sol",
      response_model: null,
      response_model_source: "target_fallback",
      target_model: "gpt-5.6-sol"
    });

    expect(responseModelDisplay(entry)).toBe("gpt-5.6-sol");
  });

  it("labels the three compaction modes by their wire signal", () => {
    expect(compactionModeLabel("remote_v1")).toBe("Remote V1");
    expect(compactionModeLabel("remote_v2")).toBe("Remote V2");
    expect(compactionModeLabel("local")).toBe("Local");
    expect(compactionDetectionLabel(requestLog({
      compaction_detection_source: "input"
    }))).toBe("compaction_trigger");
  });
});

describe("UI cache token metrics", () => {
  it("reports the cache write for both usage dialects", () => {
    // The additive flag decides whether the cache is *added* to the input total,
    // not whether the upstream told us how much it wrote. Gating the number on it
    // meant a Claude model reached through translation recorded its cache writes
    // and then displayed none, while the same model on the native Anthropic route
    // displayed them.
    const openAiDialect = requestLog({
      input_tokens: 50_100,
      output_tokens: 7,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 50_000,
      additive_cached_input_tokens: false,
      total_tokens: 50_107
    });
    expect(cacheCreationInputTokens(openAiDialect)).toBe(50_000);
    // Still a breakdown of the input rather than an addition to it.
    expect(displayInputTokens(openAiDialect)).toBe(50_100);

    const anthropicDialect = requestLog({
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
      additive_cached_input_tokens: true
    });
    expect(cacheCreationInputTokens(anthropicDialect)).toBe(50);
    expect(displayInputTokens(anthropicDialect)).toBe(150);
  });
});

function requestLog(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    time: "2026-06-09T00:00:00.000Z",
    completed_at: "2026-06-09T00:00:01.000Z",
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
    source_model: "gpt-5.5",
    target_model: "gpt-5.5",
    response_model: null,
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
    upstream_host: "muyuan.do",
    user_agent: null,
    key_name: null,
    request_id: "request-id",
    error_summary: null,
    capture_path: null,
    capture_status: "none",
    ...overrides
  };
}
