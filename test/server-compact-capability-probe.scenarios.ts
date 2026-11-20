import { describe, expect, it } from "vitest";
import { factoryClientUserAgent } from "../src/server/config-defaults.js";
import {
  captureRequest,
  postJson,
  startApp,
  startClaudeUpstream,
  startCapturedOpenAiUpstream,
  startUpstream,
  type CapturedRequest
} from "./helpers/server-test-utils.js";

describe("compact capability probe", () => {
  it.each(["failed", "incomplete"])("rejects %s JSON and SSE even with partial compaction output and later DONE", async status => {
    for (const sse of [false, true]) {
      const upstream = await startCapturedOpenAiUpstream([], (_req, res) => {
        const response = { status, ...(status === "failed" ? { error: { message: "Synthetic failed compaction" } } : {}),
          output: [{ type: "compaction", encrypted_content: "partial-state" }] };
        res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
        res.end(sse ? `data: ${JSON.stringify({ type: `response.${status}`, response })}\n\ndata: [DONE]\n\n` : JSON.stringify(response));
      });
      const app = await startApp(upstream.url, upstream.url);
      const result = await postJson(app.url, "/api/compact/capability-probe", { model: "synthetic" }).then(response => response.json());
      expect(result.supported).toBe(false);
      expect(result.failure_reason).toEqual(expect.any(String));
    }
  });

  it.each(["\n", "\r\n", "\r"])("reports a bounded real Remote V1 result without creating request logs (%j)", async newline => {
    const requests: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(requests, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "compaction", encrypted_content: "probe-state" }
      })}${newline}${newline}`);
      res.end(`data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } }
      })}${newline}${newline}`);
    });
    const app = await startApp("http://127.0.0.1:1/v1", upstream.url);

    const response = await postJson(app.url, "/api/compact/capability-probe", {
      model: "gpt-probe"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      supported: true,
      protocol: "openai_responses",
      upstream_status: 200,
      terminal_event: "response.completed",
      compaction_item_count: 1,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      failure_reason: null
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/responses/compact");
    expect(requests[0].headers["user-agent"]).toBe(factoryClientUserAgent("codex"));
    expect(JSON.parse(requests[0].body)).toMatchObject({
      model: "gpt-probe-openai-compact",
      stream: true,
      input: [{ type: "message", role: "user" }]
    });

    const logs = await fetch(`${app.url}/api/logs/recent`).then((result) => result.json()) as {
      logs: unknown[];
    };
    expect(logs.logs).toHaveLength(0);
  });

  it("leaves the capability probe identity untouched when rewriting is disabled", async () => {
    const requests: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(requests, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "state" }] }));
    });
    const app = await startApp("http://127.0.0.1:1/v1", upstream.url);
    const disabled = await postJson(app.url, "/api/client-identity", { enabled: false });
    expect(disabled.status).toBe(200);
    await disabled.text();

    const response = await postJson(app.url, "/api/compact/capability-probe", { model: "gpt-probe" });
    expect(response.status).toBe(200);
    await response.text();
    expect(requests[0].headers["user-agent"]).toBeUndefined();
  });

  it("returns unsupported details for upstream errors and rejects a missing model", async () => {
    const upstream = await startCapturedOpenAiUpstream([], (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "compact is unavailable" } }));
    });
    const app = await startApp("http://127.0.0.1:1/v1", upstream.url);

    const unsupported = await postJson(app.url, "/api/compact/capability-probe", {
      model: "gpt-probe"
    });
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({
      supported: false,
      upstream_status: 404,
      compaction_item_count: 0,
      failure_reason: expect.stringContaining("compact is unavailable")
    });

    const missingModel = await postJson(app.url, "/api/compact/capability-probe", {});
    expect(missingModel.status).toBe(400);
    expect(await missingModel.json()).toMatchObject({
      error: "compact capability probe requires model or a configured model override."
    });
  });

  it("accepts JSON compaction output without a stream terminal", async () => {
    const upstream = await startCapturedOpenAiUpstream([], (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "json-state" }]
      }));
    });
    const app = await startApp("http://127.0.0.1:1/v1", upstream.url);

    const response = await postJson(app.url, "/api/compact/capability-probe", {
      model: "gpt-probe"
    });

    expect(await response.json()).toMatchObject({
      supported: true,
      terminal_event: null,
      compaction_item_count: 1,
      failure_reason: null
    });
  });

  it("rejects an SSE compaction item without a terminal event", async () => {
    const upstream = await startCapturedOpenAiUpstream([], (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "compaction", encrypted_content: "incomplete-state" }
      })}\n\n`);
    });
    const app = await startApp("http://127.0.0.1:1/v1", upstream.url);

    const response = await postJson(app.url, "/api/compact/capability-probe", {
      model: "gpt-probe"
    });

    expect(await response.json()).toMatchObject({
      supported: false,
      compaction_item_count: 1,
      failure_reason: "Capability probe stream ended without a terminal event."
    });
  });

  it("isolates caller credentials while retaining configured transport headers", async () => {
    const requests: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(requests, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "state" }] }));
    });
    const app = await startApp("http://127.0.0.1:1/v1", upstream.url, {
      compact: {
        api_key: "configured-key",
        extra_headers: { "x-probe-extra": "configured-value" }
      }
    });

    const response = await fetch(`${app.url}/api/compact/capability-probe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-key",
        cookie: "caller-session=secret"
      },
      body: JSON.stringify({ model: "gpt-probe" })
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(requests[0].headers.authorization).toBe("Bearer configured-key");
    expect(requests[0].headers.cookie).toBeUndefined();
    expect(requests[0].headers["x-probe-extra"]).toBe("configured-value");
    expect(requests[0].headers["accept-encoding"]).toBe("identity");
  });

  it.each(["\n", "\r\n", "\r"])("probes Anthropic native compaction and rejects Chat without a network request (%j)", async newline => {
    const anthropicRequests: CapturedRequest[] = [];
    const anthropic = await startClaudeUpstream(async (req, res) => {
      anthropicRequests.push(await captureRequest(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start${newline}data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_probe", usage: { input_tokens: 5, output_tokens: 0 } }
      })}${newline}${newline}`);
      res.write(`event: content_block_start${newline}data: ${JSON.stringify({
        type: "content_block_start",
        content_block: { type: "compaction", content: "summary" }
      })}${newline}${newline}`);
      res.end(`event: message_stop${newline}data: ${JSON.stringify({ type: "message_stop" })}${newline}${newline}`);
    });
    const anthropicApp = await startApp("http://127.0.0.1:1/v1", anthropic.url, {
      compact: { upstream_protocol: "anthropic_messages", model_template: "{model}" }
    });
    const anthropicResponse = await postJson(
      anthropicApp.url,
      "/api/compact/capability-probe",
      { model: "claude-probe" }
    );
    expect(await anthropicResponse.json()).toMatchObject({
      supported: true,
      protocol: "anthropic_messages",
      terminal_event: "message_stop",
      compaction_item_count: 1,
      usage: { inputTokens: 5 }
    });
    expect(anthropicRequests[0].url).toBe("/v1/messages");
    expect(anthropicRequests[0].headers["user-agent"]).toBe(factoryClientUserAgent("claude"));
    expect(anthropicRequests[0].headers["anthropic-beta"]).toContain("compact-2026-01-12");
    expect(JSON.parse(anthropicRequests[0].body)).toHaveProperty("context_management");

    let chatRequests = 0;
    const chat = await startUpstream((_req, res) => {
      chatRequests += 1;
      res.end("{}");
    });
    const chatApp = await startApp("http://127.0.0.1:1/v1", chat.url, {
      compact: { upstream_protocol: "openai_chat" }
    });
    const chatResponse = await postJson(chatApp.url, "/api/compact/capability-probe", {
      model: "chat-probe"
    });
    expect(await chatResponse.json()).toMatchObject({
      supported: false,
      protocol: "openai_chat",
      upstream_status: null
    });
    expect(chatRequests).toBe(0);
  });

  it("stops reading when the bounded response buffer is exceeded", async () => {
    let upstreamClosed = false;
    const upstream = await startUpstream((_req, res) => {
      res.once("close", () => {
        upstreamClosed = true;
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${"x".repeat(600 * 1024)}\n\n`);
    });
    const app = await startApp("http://127.0.0.1:1/v1", upstream.url);

    const response = await postJson(app.url, "/api/compact/capability-probe", {
      model: "gpt-probe"
    });
    expect(await response.json()).toMatchObject({
      supported: false,
      failure_reason: expect.stringContaining("exceeded")
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(upstreamClosed).toBe(true);
  });
});
