import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicPassthroughResponseTransform, createChatToResponsesResponseTransform, createResponsesToAnthropicResponseTransform } from "../src/server/protocol-stream.js";
import { resolveLogDatabasePath } from "../src/server/logger.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { captureBody, cleanup, postJson, readLatestLogBodyFields, setEnv, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

describe("production response budgets", () => {
  it.each(["primary", "claude"] as const)("delivers a long %s stream completely with a bounded diagnostic copy and final usage", async (route) => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-budget-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);
    setEnv("COMPACTGATE_CAPTURE_BODY_MAX_BYTES", "1024");
    const start = route === "claude"
      ? 'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"synthetic","content":[],"usage":{"input_tokens":123,"output_tokens":1}}}\n\n'
      : 'event: response.created\ndata: {"type":"response.created","response":{"id":"synthetic","model":"synthetic","usage":{"input_tokens":123,"output_tokens":1}}}\n\n';
    const end = route === "claude"
      ? `event: message_delta\ndata: {"type":"message_delta","padding":"${"x".repeat(70 * 1024)}","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":456}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
      : `event: response.completed\ndata: {"type":"response.completed","response":{"id":"synthetic","model":"synthetic","output":"${"x".repeat(70 * 1024)}","usage":{"input_tokens":123,"output_tokens":456}}}\n\n`;
    const padding = `: ${"x".repeat(65530)}\n\n`;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.setHeader("content-type", "text/event-stream");
      res.write(start);
      for (let i = 0; i < 140; i++) if (!res.write(padding)) await once(res, "drain");
      res.end(end);
    });
    const app = await startApp(upstream.url, undefined, {
      logging: { capture_dir: captureDir, persist_body: true },
      primary: { api_key: "synthetic", api_key_env: "" },
      claude: { primary: { base_url: upstream.url, api_key: "synthetic", api_key_env: "" } }
    });
    const response = await postJson(app.url, route === "claude" ? "/anthropic/v1/messages" : "/v1/responses", {
      model: "synthetic", input: "synthetic", messages: [{ role: "user", content: "synthetic" }], stream: true
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(start + padding.repeat(140) + end);
    const entry = await waitForLogEntry(app.url, (log) => log.request_id === response.headers.get("x-compactgate-request-id") && log.capture_status === "present");
    expect(entry).toMatchObject({ upstream_response_truncated: true, stream_outcome: "success", input_tokens: 123, output_tokens: 456 });
    const capture = await (await fetch(`${app.url}/api/logs/${entry.request_id}/capture`)).json();
    expect(capture.upstream_response.body).toMatchObject({ byte_length: Buffer.byteLength(start + padding.repeat(140) + end), captured_byte_length: 1024, truncated: true });
    const persisted = readLatestLogBodyFields(resolveLogDatabasePath(app.config.getConfigPath()));
    expect(persisted.upstream_response_body).toContain("diagnostic body truncated");
    if (route === "claude") {
      expect(capture.client_response.body).toMatchObject({ byte_length: capture.upstream_response.body.byte_length, captured_byte_length: 1024, truncated: true });
      expect(persisted.client_response_body).toContain("diagnostic body truncated");
    }
  });

  it.each(["json", "sse"] as const)("preserves the continuation ID beyond the diagnostic prefix in %s", async (format) => {
    const prefix = ": " + "x".repeat(65530) + "\n\n";
    const payload = { id: "resp_synthetic_large", model: "synthetic", output: format === "json" ? "x".repeat(9 * 1024 * 1024) : [], usage: { input_tokens: 123, output_tokens: 456 } };
    const body = format === "json" ? JSON.stringify(payload)
      : prefix.repeat(140) + `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.setHeader("content-type", format === "json" ? "application/json" : "text/event-stream");
      res.end(body);
    });
    const app = await startApp(upstream.url, undefined, { primary: { api_key: "synthetic", api_key_env: "" }, primary_failover: { auto_schedule: false } });
    await app.config.saveProfile("codex", "Synthetic", {});
    await app.config.applyProfile("codex", app.config.get().profile_scopes!.codex!.profiles![0].id);
    const results = vi.spyOn(PrimaryFailoverState.prototype, "recordResult");
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic", input: "synthetic", stream: format === "sse" });
    expect(await response.text()).toBe(body);
    const log = await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log).toMatchObject({ status: 200, input_tokens: 123, output_tokens: 456 });
    expect(results.mock.calls[0]?.[1]).toMatchObject({ responseId: payload.id });
  });

  it("does not report intermediate usage as final when the terminal event exceeds the observation budget", async () => {
    const body = 'event: response.created\ndata: {"response":{"usage":{"input_tokens":123,"output_tokens":1}}}\n\n' +
      `event: response.completed\ndata: {"response":{"output":"${"x".repeat(8 * 1024 * 1024)}","usage":{"input_tokens":123,"output_tokens":456}}}\n\n`;
    const upstream = await startUpstream(async (req, res) => { await captureBody(req); res.setHeader("content-type", "text/event-stream"); res.end(body); });
    const app = await startApp(upstream.url);
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic", input: "synthetic", stream: true });
    expect(await response.text()).toBe(body);
    const log = await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log).toMatchObject({ status: 200, stream_outcome: "success", stream_oversized_event_count: 1, input_tokens: null, output_tokens: null });
  });

  it.each(["/v1/responses", "/v1/responses/compact"])("rejects oversized complete JSON on %s without replaying a partial result", async (endpoint) => {
    let calls = 0;
    const body = Buffer.from(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "x".repeat(32 * 1024 * 1024) }] }));
    const upstream = await startUpstream(async (req, res) => {
      calls++;
      await captureBody(req);
      res.setHeader("content-type", "application/json");
      res.end(body);
    });
    const app = await startApp(upstream.url, upstream.url, { compact: { api_key: "synthetic", api_key_env: "" } });
    for (let i = 0; i < 2; i++) {
      const response = await postJson(app.url, endpoint, { model: "synthetic", input: "same input" });
      expect(await response.text().then(() => true, () => false)).toBe(false);
      const log = await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
      expect(log).toMatchObject({ status: 502, upstream_response_truncated: true, error_summary: expect.stringContaining("complete-response limit") });
    }
    expect(calls).toBe(2);
  });

  it.each(["json", "sse"] as const)("rejects %s conversion input beyond the complete-response budget", async (format) => {
    const headers = { "content-type": format === "sse" ? "text/event-stream" : "application/json" };
    const adapter = format === "sse"
      ? createChatToResponsesResponseTransform(200, headers)
      : createResponsesToAnthropicResponseTransform(200, headers);
    const completion = finished(adapter.stream);
    adapter.stream.resume();
    adapter.stream.end(Buffer.alloc(32 * 1024 * 1024 + 1, " "));
    await expect(completion).rejects.toMatchObject({ code: "ERR_UPSTREAM_RESPONSE_TOO_LARGE" });
  });

  it("reports a repair-frame limit crossed while flushing an incomplete UTF-8 character", async () => {
    const adapter = createAnthropicPassthroughResponseTransform(200, { "content-type": "text/event-stream" })!;
    const completion = finished(adapter.stream);
    adapter.stream.resume();
    adapter.stream.write(Buffer.alloc(32 * 1024 * 1024 - 1, " "));
    adapter.stream.end(Buffer.from([0xe4]));
    await expect(completion).rejects.toMatchObject({ code: "ERR_UPSTREAM_RESPONSE_TOO_LARGE" });
  });
});
