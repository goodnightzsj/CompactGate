import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeResponseText } from "../src/server/usage-utils.js";
import { extractResponseUsage } from "../src/server/usage.js";
import { extractResponseModelFromBodies } from "../src/server/response-model.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

describe("complete JSON metadata decode budget", () => {
  it.each([
    { name: "br", encode: brotliCompressSync },
    { name: "deflate", encode: deflateSync },
    { name: "zstd", encode: zstdCompressSync }
  ])("shares the complete budget for $name while retaining the SSE budget", ({ name, encode }) => {
    const text = JSON.stringify({ model: "synthetic-model", padding: "x".repeat(9 * 1024 * 1024),
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } });
    const body = encode(Buffer.from(text));
    const headers = { "content-type": "application/json", "content-encoding": name };
    expect(decodeResponseText(body, headers)).toBe(text);
    expect(extractResponseUsage(body, headers)).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(extractResponseModelFromBodies(body, null, headers)).toBe("synthetic-model");
    expect(decodeResponseText(body, { ...headers, "content-type": "text/event-stream" })).toBeNull();
  });

  it.each([
    ["small gzip", 512, true],
    ["large identity", 9 * 1024 * 1024, false],
    ["large gzip", 9 * 1024 * 1024, true]
  ] as const)("preserves delivered usage and model: %s", async (_name, padding, compressed) => {
    const text = JSON.stringify({ id: "resp_r7_synthetic", object: "response", status: "completed",
      model: "synthetic-declared", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(padding) }] }],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } });
    expect(Buffer.byteLength(text)).toBeLessThan(10 * 1024 * 1024);
    const body = compressed ? gzipSync(text) : Buffer.from(text);
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json", ...(compressed ? { "content-encoding": "gzip" } : {}) });
      res.end(body);
    });
    const app = await startApp(upstream.url);
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic-target", input: "synthetic", stream: false });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    const entry = await waitForLogEntry(app.url, row => row.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry.upstream_response_truncated).toBe(false);
    expect.soft(entry).toMatchObject({ stream_outcome: "success", input_tokens: 12, output_tokens: 8, total_tokens: 20,
      response_model: "synthetic-declared", response_model_source: "upstream" });
    const stats = await fetch(`${app.url}/api/logs/stats?view=usage`).then(result => result.json());
    expect(stats.summary).toMatchObject({ requests: 1, usage_observed_requests: 1, input_tokens: 12, output_tokens: 8, total_tokens: 20 });
  });

  it.each([
    ["small gzip", 512, true],
    ["large identity", 9 * 1024 * 1024, false],
    ["large gzip", 9 * 1024 * 1024, true]
  ] as const)("preserves delivered failed JSON envelope: %s", async (_name, padding, compressed) => {
    const text = JSON.stringify({ id: "resp_r7_synthetic_failed", object: "response", status: "failed",
      model: "synthetic-declared", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(padding) }] }],
      error: { type: "server_error", message: "Synthetic generation failed" } });
    expect(Buffer.byteLength(text)).toBeLessThan(10 * 1024 * 1024);
    const body = compressed ? gzipSync(text) : Buffer.from(text);
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json", ...(compressed ? { "content-encoding": "gzip" } : {}) });
      res.end(body);
    });
    const app = await startApp(upstream.url);
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic-target", input: "synthetic", stream: false });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    const entry = await waitForLogEntry(app.url, row => row.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry.upstream_response_truncated).toBe(false);
    expect.soft(entry.error_summary).toContain("Synthetic generation failed");
    expect.soft(entry.stream_outcome).not.toBe("success");
    const stats = await fetch(`${app.url}/api/logs/stats?view=usage`).then(result => result.json());
    expect(stats.summary).toMatchObject({ requests: 1, normal_requests: 0, error_requests: 1 });
  });
});
