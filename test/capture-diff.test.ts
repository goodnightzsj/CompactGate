import { describe, expect, it } from "vitest";
import {
  captureRequestDiff,
  captureResponseDiff,
  diffCapturePayloads
} from "../src/shared/capture-diff.js";
import type { CaptureRecord, CapturePayload, CaptureResponsePayload } from "../src/shared/types.js";

function payload(value: unknown): CapturePayload {
  const text = JSON.stringify(value);
  return {
    headers: { "content-type": "application/json" },
    body: {
      byte_length: Buffer.byteLength(text),
      captured_byte_length: Buffer.byteLength(text),
      truncated: false,
      text,
      base64: Buffer.from(text).toString("base64")
    }
  };
}

function response(value: unknown): CaptureResponsePayload {
  return { ...payload(value), status: 200 };
}

function capture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    request_id: "request-id",
    time: "2026-08-16T00:00:00.000Z",
    completed_at: "2026-08-16T00:00:01.000Z",
    route: "primary",
    method: "POST",
    path: "/v1/responses",
    upstream_url: "http://upstream.test/v1/responses",
    upstream_host: "upstream.test",
    source_model: "model",
    target_model: "model",
    compact_bridge_replacements: 0,
    compact_response_normalized: false,
    compact_response_normalize_reason: null,
    compact_response_synthetic_source: null,
    incoming_request: payload({ model: "a", input: [{ type: "text", text: "one" }] }),
    upstream_request: payload({ model: "b", input: [{ type: "text", text: "one" }], stream: true }),
    upstream_response: response({ output: [{ type: "message", text: "upstream" }] }),
    client_response: response({ output: [{ type: "message", text: "client" }] }),
    ...overrides
  };
}

describe("capture structural diff", () => {
  it("reports added, removed, and changed JSON paths", () => {
    const diff = captureRequestDiff(capture());
    expect(diff.available).toBe(true);
    expect(diff.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.model", kind: "changed" }),
      expect.objectContaining({ path: "$.stream", kind: "added" })
    ]));
  });

  it("treats transparent client responses as equivalent", () => {
    const diff = captureResponseDiff(capture({ client_response: null }));
    expect(diff).toEqual({
      available: true,
      equivalent: true,
      reason: "transparent",
      entries: [],
      truncated: false
    });
  });

  it("bounds entries and refuses malformed or truncated payloads", () => {
    const many = payload(Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, index])));
    const limited = diffCapturePayloads(many, payload({}), 3);
    expect(limited.truncated).toBe(true);
    expect(limited.reason).toBe("diff_limit");
    expect(diffCapturePayloads({ ...many, body: { ...many.body, text: "{" } }, many).reason)
      .toBe("invalid_json");
    expect(diffCapturePayloads({ ...many, body: { ...many.body, truncated: true } }, many).reason)
      .toBe("truncated");
  });
});
