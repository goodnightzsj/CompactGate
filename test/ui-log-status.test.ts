import { describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import { logStatusKind, logStatusToneClass } from "../src/ui/logs/log-utils.js";

describe("UI log status helpers", () => {
  it("treats a 2xx response with only a diagnostic summary as an error", () => {
    const entry = requestLog({
      status: 200,
      error_summary: "OpenAI stream closed before response.completed."
    });

    expect(logStatusKind(entry)).toBe("error");
    expect(logStatusToneClass(entry)).toBe("is-err");
  });

  it("keeps a diagnostic response with token details in the normal status bucket", () => {
    const entry = requestLog({
      status: 200,
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      error_summary: "OpenAI stream ended with response.failed."
    });

    expect(logStatusKind(entry)).toBe("normal");
    expect(logStatusToneClass(entry)).toBe("is-ok");
  });

  it("keeps clean 2xx responses in the normal status bucket", () => {
    const entry = requestLog({
      status: 200,
      error_summary: null
    });

    expect(logStatusKind(entry)).toBe("normal");
    expect(logStatusToneClass(entry)).toBe("is-ok");
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
    compact_response_normalized: false,
    compact_response_normalize_reason: null,
    compact_response_synthetic_source: null,
    source_model: "gpt-5.5",
    target_model: "gpt-5.5",
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
    request_id: "request-id",
    error_summary: null,
    ...overrides
  };
}
