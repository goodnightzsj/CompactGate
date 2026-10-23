import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { previewRoute } from "../src/server/routing.js";
import {
  captureBody, postJson, startApp, startClaudeUpstream, waitForLogEntry, writeJsonResponse
} from "./helpers/server-test-utils.js";

const protocols = ["openai_responses", "openai_chat", "anthropic_messages"] as const;
const catalog = { object: "list", data: [{ id: "synthetic-model", object: "model", created: 1, owned_by: "test" }], has_more: false };
const chatRequest = {
  model: "synthetic-model", stream: false, store: false, max_completion_tokens: 128,
  reasoning_effort: "high", stream_options: { include_usage: true },
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  messages: [
    { role: "developer", content: "Synthetic instruction" },
    { role: "user", content: "Synthetic question" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_test", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_test", content: "Synthetic result" }
  ]
};
const chatResponse = {
  id: "chatcmpl_test", object: "chat.completion", model: "synthetic-model",
  choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
};

describe.each(protocols)("agent model discovery through %s", (upstream_protocol) => {
  it.each(["/models", "/v1/models", "/anthropic/models", "/anthropic/v1/models"])("forwards %s without generation conversion", async (path) => {
    const requests: string[] = [];
    const upstream = await startClaudeUpstream(async (req, res) => {
      requests.push(req.url!);
      expect(req.method).toBe("GET");
      expect(await captureBody(req)).toBe("");
      expect(req.headers.authorization).toBe("Bearer synthetic-key");
      if (upstream_protocol === "anthropic_messages") expect(req.headers["anthropic-api-key"]).toBe("synthetic-key");
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify(catalog)));
    });
    const base_url = `${upstream.url}/vendor${upstream_protocol === "anthropic_messages" ? "" : "/v4"}?flag=keep&client_version=old`;
    const route = { base_url, upstream_protocol, api_key: "synthetic-key" };
    const app = await startApp(undefined, undefined, { primary: route, claude: { primary: route } });
    const response = await fetch(`${app.url}${path}?client_version=pi&tag=a&tag=b&after_id=cursor`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
    const prefix = upstream_protocol === "anthropic_messages" ? "/vendor/v1" : "/vendor/v4";
    expect(requests).toEqual([`${prefix}/models?flag=keep&client_version=pi&tag=a&tag=b&after_id=cursor`]);
    expect(previewRoute("GET", `${path}?client_version=pi&tag=a&tag=b&after_id=cursor`, undefined, app.config.get())).toMatchObject({
      upstream_url: `${upstream.url}${requests[0]}`, translation_mode: "passthrough"
    });
  });
});

describe("generic agent generation", () => {
  it.each(["/v1/chat/completions", "/chat/completions"])("preserves Chat JSON and tool history at %s", async (path) => {
    const seen: unknown[] = [];
    const upstream = await startClaudeUpstream(async (req, res) => {
      expect(req.url).toBe("/v1/chat/completions");
      seen.push(JSON.parse((await captureBody(req)).toString()));
      writeJsonResponse(res, chatResponse);
    });
    const app = await startApp(`${upstream.url}/v1`, undefined, { primary: { upstream_protocol: "openai_chat" } });
    const response = await postJson(app.url, path, chatRequest, { "user-agent": "pi (synthetic)" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(chatResponse);
    expect(seen).toEqual([chatRequest]);
    expect(previewRoute("POST", path, chatRequest, app.config.get())).toMatchObject({
      upstream_url: `${upstream.url}/v1/chat/completions`, ingress_protocol: "openai_chat", translation_mode: "passthrough"
    });
    const log = await waitForLogEntry(app.url, () => true);
    expect(log).toMatchObject({ status: 200, stream_outcome: "success", error_summary: null });
  });

  it("preserves Chat SSE tool deltas and DONE without retry or Responses conversion", async () => {
    let calls = 0;
    const chunks = [
      { id: "chatcmpl_test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "chatcmpl_test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
    ];
    const wire = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const upstream = await startClaudeUpstream(async (req, res) => {
      calls++;
      expect(JSON.parse((await captureBody(req)).toString())).toEqual({ ...chatRequest, stream: true });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(wire);
    });
    const app = await startApp(`${upstream.url}/v1`, undefined, { primary: { upstream_protocol: "openai_chat" } });
    const response = await postJson(app.url, "/v1/chat/completions", { ...chatRequest, stream: true }, { "user-agent": "other-agent" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(wire);
    expect(calls).toBe(1);
    expect(await waitForLogEntry(app.url, () => true)).toMatchObject({ stream_outcome: "success", error_summary: null });
  });

  it.each([
    ["/anthropic/chat/completions", "anthropic_messages"],
    ["/anthropic/v1/chat/completions", "anthropic_messages"],
    ["/anthropic/v1/responses", "openai_responses"],
    ["/v1/chat/completions", "openai_responses"],
    ["/v1/chat/completions", "anthropic_messages"],
    ["/v1/messages", "anthropic_messages"]
  ] as const)("rejects incompatible %s to %s before sending", async (path, upstream_protocol) => {
    let calls = 0;
    const upstream = await startClaudeUpstream((_req, res) => { calls++; writeJsonResponse(res, chatResponse); });
    const route = { base_url: `${upstream.url}/v1`, upstream_protocol };
    const app = await startApp(undefined, undefined, { primary: route, claude: { primary: route } });
    const response = await postJson(app.url, path, { ...chatRequest, stream: true }, { "user-agent": "pi (synthetic)" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", code: "unsupported_protocol", message: expect.any(String) } });
    expect(calls).toBe(0);
    expect(await waitForLogEntry(app.url, () => true)).toMatchObject({ status: 400, upstream_status: null });
  });

  it.each(["/anthropic/messages", "/anthropic/v1/messages"])("forwards native Messages from other agents at %s", async (path) => {
    const requests: unknown[] = [];
    const request = { model: "synthetic-model", max_tokens: 32, messages: [{ role: "user", content: "test" }] };
    const message = { id: "msg_test", type: "message", role: "assistant", model: "synthetic-model", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } };
    const upstream = await startClaudeUpstream(async (req, res) => {
      requests.push({ path: req.url, body: JSON.parse(await captureBody(req)) });
      writeJsonResponse(res, message);
    });
    const app = await startApp(undefined, undefined, { claude: { primary: { base_url: upstream.url } } });
    const response = await postJson(app.url, path, request, { "user-agent": "other-agent" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(message);
    expect(requests).toEqual([{ path: "/v1/messages", body: request }]);
  });

  it.each(["/v1/responses", "/anthropic/v1/messages"])("preserves native SSE from a non-CLI client at %s", async (path) => {
    let calls = 0;
    const anthropic = path.startsWith("/anthropic");
    const events = anthropic ? [
      { type: "message_start", message: { id: "msg_test", role: "assistant", model: "synthetic-model", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" }
    ] : [
      { type: "response.output_text.delta", delta: "done" },
      { type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 2, output_tokens: 1 } } }
    ];
    const wire = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const upstream = await startClaudeUpstream(async (req, res) => {
      calls++;
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(wire);
    });
    const app = await startApp(`${upstream.url}/v1`, undefined, { claude: { primary: { base_url: upstream.url } } });
    const body = anthropic ? { model: "synthetic-model", stream: true, max_tokens: 32, messages: [{ role: "user", content: "test" }] }
      : { model: "synthetic-model", stream: true, input: "test" };
    const response = await postJson(app.url, path, body, { "user-agent": "generic-agent" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(wire);
    expect(calls).toBe(1);
    expect(await waitForLogEntry(app.url, () => true)).toMatchObject({ stream_outcome: "success", error_summary: null });
  });

  it("records a truncated Chat stream as failure without internal replay", async () => {
    let calls = 0;
    const wire = 'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
    const upstream = await startClaudeUpstream(async (req, res) => {
      calls++;
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(wire);
    });
    const app = await startApp(`${upstream.url}/v1`, undefined, { primary: { upstream_protocol: "openai_chat" } });
    const response = await postJson(app.url, "/v1/chat/completions", { ...chatRequest, stream: true });
    expect(await response.text()).toBe(wire);
    expect(calls).toBe(1);
    expect(await waitForLogEntry(app.url, () => true)).toMatchObject({ stream_outcome: "upstream_stream_incomplete", error_summary: expect.any(String) });
  });

  it.each([401, 429, 502])("preserves a Chat %s without internal replay", async (status) => {
    let calls = 0;
    const error = { error: { type: "synthetic_error", code: "test", message: "synthetic rejection" } };
    const upstream = await startClaudeUpstream(async (req, res) => { calls++; await captureBody(req); writeJsonResponse(res, error, status); });
    const app = await startApp(`${upstream.url}/v1`, undefined, { primary: { upstream_protocol: "openai_chat" } });
    const response = await postJson(app.url, "/v1/chat/completions", { ...chatRequest, stream: true });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(error);
    expect(calls).toBe(1);
  });
});

describe("invalid upstream API responses", () => {
  it.each(["/models", "/v1/models", "/anthropic/models", "/anthropic/v1/messages", "/v1/responses", "/v1/chat/completions"])("does not pass HTML success through %s", async (path) => {
    let calls = 0;
    const upstream = await startClaudeUpstream((_req, res) => {
      calls++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Synthetic console</title>");
    });
    const app = await startApp(`${upstream.url}/v1`, undefined, {
      primary: { upstream_protocol: path.includes("chat") ? "openai_chat" : "openai_responses" },
      claude: { primary: { base_url: upstream.url } }
    });
    const response = path.endsWith("models") ? await fetch(`${app.url}${path}`)
      : await postJson(app.url, path, path.includes("chat") ? chatRequest : { model: "synthetic-model", stream: true, input: "test", messages: [{ role: "user", content: "test" }] });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("HTML");
    expect(calls).toBe(1);
    const log = await waitForLogEntry(app.url, () => true);
    expect(log).toMatchObject({ status: 502, upstream_status: 200 });
    expect(log.stream_outcome).not.toBe("success");
  });

  it.each([401, 404, 405, 429, 500])("keeps upstream model error %s without retry", async (status) => {
    let calls = 0;
    const error = { error: { type: "synthetic_error", message: "synthetic rejection", code: "test" } };
    const upstream = await startClaudeUpstream((_req, res) => { calls++; writeJsonResponse(res, error, status); });
    const app = await startApp(`${upstream.url}/v1`, undefined, { primary: { upstream_protocol: "openai_chat" } });
    const response = await fetch(`${app.url}/models`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(error);
    expect(calls).toBe(1);
  });
});
