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

  it("distinguishes a valid JSON null from a parse failure or an absent response", () => {
    expect(diffCapturePayloads(payload(null), payload(null))).toMatchObject({ available: true, equivalent: true, reason: null });
    expect(captureResponseDiff(capture({ upstream_response: response(null), client_response: response({}) }))).toMatchObject({
      available: true, equivalent: false, entries: [{ path: "$", kind: "changed", before: "null", after: "{}" }]
    });
    const malformed = payload(null);
    malformed.body.text = "";
    expect(diffCapturePayloads(payload(null), malformed).reason).toBe("invalid_json");
  });

  it("treats transparent client responses as equivalent", () => {
    const diff = captureResponseDiff(capture({ client_response: null, stream_outcome: "success" }));
    expect(diff).toEqual({
      available: true,
      equivalent: true,
      reason: "transparent",
      entries: [],
      truncated: false
    });
  });

  it("checks structural equality at the depth boundary and still reports unrelated changes", () => {
    const nested = (leaf: unknown) => Array.from({ length: 31 }).reduce<unknown>(value => [value], leaf);
    const before = payload({ nested: nested({ a: 1, b: false }), side: 0 });
    const same = payload({ side: 0, nested: nested({ b: false, a: 1 }) });
    expect(diffCapturePayloads(before, same)).toMatchObject({ equivalent: true, entries: [], truncated: false });
    expect(diffCapturePayloads(before, payload({ nested: nested({ b: false, a: 1 }), side: 1 }))).toMatchObject({
      entries: [{ path: "$.side" }], truncated: false
    });
    expect(diffCapturePayloads(before, payload({ nested: nested({ b: true, a: 1 }), side: 0 }))).toMatchObject({
      equivalent: false, entries: [{ path: "$.nested" + "[0]".repeat(31), kind: "changed" }], truncated: false
    });
  });

  it.each([undefined, null, "upstream_request_error"] as const)("does not infer equality from missing client bytes with outcome %s", stream_outcome => {
    expect(captureResponseDiff(capture({ client_response: null, stream_outcome }))).toMatchObject({
      available: false, equivalent: false, reason: "unavailable"
    });
  });

  it("distinguishes an unexamined deep branch from a known change and handles identical deep JSON", () => {
    const raw = (leaf: string) => "[".repeat(12000) + leaf + "]".repeat(12000);
    const body = (text: string) => ({ ...payload(null), body: { ...payload(null).body, text } });
    const deep = body(raw("0"));
    expect(diffCapturePayloads(deep, deep)).toMatchObject({ equivalent: true, entries: [], truncated: false });
    expect(diffCapturePayloads(deep, body(raw("1")))).toMatchObject({
      equivalent: false, entries: [], truncated: true, reason: "depth_limit"
    });
    const added = diffCapturePayloads(payload({}), body('{"addition":' + raw("1") + '}'));
    expect(added.entries).toHaveLength(1);
    expect(added.entries[0]).toMatchObject({ kind: "added", path: "$.addition", after: "[".repeat(240) + "..." });
  });

  it("only truncates after finding a genuine difference past the entry limit", () => {
    const object = (changed: number, tail: number) => payload({
      ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, changed])), tail: [tail]
    });
    const exact = diffCapturePayloads(object(0, 0), object(1, 0));
    expect(exact.entries).toHaveLength(200);
    expect(exact).toMatchObject({ truncated: false, equivalent: false, reason: null });
    const overflow = diffCapturePayloads(object(0, 0), object(1, 1));
    expect(overflow.entries).toHaveLength(200);
    expect(overflow).toMatchObject({ truncated: true, reason: "diff_limit" });
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
