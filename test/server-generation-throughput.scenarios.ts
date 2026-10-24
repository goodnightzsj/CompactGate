import { setTimeout as delay } from "node:timers/promises";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { captureBody, openSseStream, postJson, startApp, startClaudeUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";
import type { StudioLogEvent, UpstreamProtocol } from "../src/shared/types.js";

function frame(type: string, value: object) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function responseFrames(protocol: UpstreamProtocol): [string, string, string] {
  if (protocol === "anthropic_messages") return [
    frame("message_start", { message: { id: "msg_sample", type: "message", role: "assistant", model: "synthetic", content: [], usage: { input_tokens: 20, output_tokens: 0 } } }) +
      frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
    frame("content_block_stop", { index: 0 }) +
      frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } }) + frame("message_stop", {})
  ];
  if (protocol === "openai_chat") {
    const chunk = (delta: object, finish_reason: string | null = null, usage?: object) =>
      `data: ${JSON.stringify({ id: "chat_sample", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`;
    return [chunk({ role: "assistant", content: "" }), chunk({ content: "hello" }),
      chunk({}, "stop", { prompt_tokens: 20, completion_tokens: 100, total_tokens: 120 }) + "data: [DONE]\n\n"];
  }
  const part = { type: "output_text", text: "hello", annotations: [] };
  const item = { type: "message", id: "msg_sample", role: "assistant", status: "completed", content: [part] };
  const response = { id: "resp_sample", object: "response", model: "synthetic", output: [], usage: null };
  return [
    frame("response.created", { response }) +
      frame("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }) +
      frame("response.content_part.added", { output_index: 0, content_index: 0, part: { ...part, text: "" } }),
    frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "hello" }),
    frame("response.output_text.done", { output_index: 0, content_index: 0, text: "hello" }) +
      frame("response.content_part.done", { output_index: 0, content_index: 0, part }) +
      frame("response.output_item.done", { output_index: 0, item }) +
      frame("response.completed", { response: { ...response, status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 100, total_tokens: 120 } } })
  ];
}

async function streamResponse(res: ServerResponse, protocol: UpstreamProtocol) {
  const [envelope, output, terminal] = responseFrames(protocol);
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(envelope);
  await delay(120);
  res.write(output);
  await delay(180);
  res.write(terminal);
  await delay(140);
  res.end();
}

const request = { model: "synthetic", stream: true, max_tokens: 128, messages: [{ role: "user", content: "synthetic" }] };
function route(base_url: string, upstream_protocol: UpstreamProtocol) {
  return { base_url, upstream_protocol, api_key: "synthetic-not-a-credential", api_key_env: "" };
}

describe("generation samples across proxy and persistence boundaries", () => {
  it.each([
    ["/v1/responses", "openai_responses"],
    ["/v1/responses", "anthropic_messages"],
    ["/v1/responses", "openai_chat"],
    ["/v1/chat/completions", "openai_chat"],
    ["/anthropic/v1/messages", "anthropic_messages"],
    ["/anthropic/v1/messages", "openai_responses"],
    ["/anthropic/v1/messages", "openai_chat"]
  ] as const)("keeps source timing for %s through %s and agrees across REST/SSE", async (endpoint, protocol) => {
    const upstream = await startClaudeUpstream(async (req, res) => {
      await captureBody(req);
      await streamResponse(res, protocol);
    });
    const config = route(`${upstream.url}/v1`, protocol);
    const app = await startApp(undefined, undefined, { primary: config, claude: { primary: config } });
    const events = await openSseStream(`${app.url}/api/events`);
    const body = endpoint === "/v1/responses" ? { model: "synthetic", stream: true, input: "synthetic" } : request;
    const response = await postJson(app.url, endpoint, body);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello");
    const entry = await waitForLogEntry(app.url, value => value.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry).toMatchObject({ stream_outcome: "success", output_tokens: 100, total_tokens: 120 });
    expect(entry.generation_sample?.output_tokens).toBe(100);
    expect(entry.generation_sample!.duration_ms).toBeGreaterThanOrEqual(100);
    expect(entry.generation_sample!.first_output_ms - entry.first_token_ms!).toBeGreaterThan(60);
    expect(entry.generation_sample!.duration_ms).toBeLessThan(entry.duration_ms);
    const event = await events.waitForEvent("log") as StudioLogEvent;
    expect(event.entry.generation_sample).toEqual(entry.generation_sample);
    expect(event.entry.incoming_request_body).toBeNull();
    await events.close();
  });

  it("uses only the final retry attempt's output and excludes retry waiting from generation time", async () => {
    let calls = 0;
    const upstream = await startClaudeUpstream(async (req, res) => {
      await captureBody(req);
      calls++;
      if (calls === 1) {
        res.writeHead(503, { "content-type": "text/event-stream", "retry-after": "0" });
        res.end(responseFrames("openai_responses").join("").replaceAll('"output_tokens":100', '"output_tokens":900'));
      } else await streamResponse(res, "openai_responses");
    });
    const app = await startApp(`${upstream.url}/v1`, `${upstream.url}/v1`, { compact: { api_key: "synthetic", api_key_env: "" } });
    const response = await postJson(app.url, "/v1/responses/compact", { model: "synthetic", input: "synthetic", stream: true });
    expect(response.status).toBe(200);
    await response.text();
    const entry = await waitForLogEntry(app.url, value => value.request_id === response.headers.get("x-compactgate-request-id"));
    expect(calls).toBe(2);
    expect(entry.generation_sample?.output_tokens).toBe(100);
    expect(entry.generation_sample!.duration_ms).toBeGreaterThanOrEqual(100);
    const replay = await postJson(app.url, "/v1/responses/compact", { model: "synthetic", input: "synthetic", stream: true });
    await replay.text();
    const cached = await waitForLogEntry(app.url, value => value.request_id === replay.headers.get("x-compactgate-request-id"));
    expect(calls).toBe(2);
    expect(cached).toMatchObject({ generation_sample: null, first_token_ms: null, output_tokens: null });
  });

  it.each(["json", "count", "error", "incomplete"])("does not invent generation speed for %s", async (kind) => {
    const upstream = await startClaudeUpstream(async (req, res) => {
      await captureBody(req);
      if (kind === "json") {
        writeJsonResponse(res, { id: "msg_sample", type: "message", content: [{ type: "text", text: "hello" }], usage: { output_tokens: 100 } });
        return;
      }
      const [envelope, output, terminal] = responseFrames("anthropic_messages");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(envelope + output);
      await delay(120);
      res.end(kind === "error" ? frame("error", { error: { type: "api_error", message: "synthetic failure" } }) : kind === "incomplete" ? "" : terminal);
    });
    const app = await startApp(undefined, undefined, { claude: { primary: route(upstream.url, "anthropic_messages") } });
    const endpoint = kind === "count" ? "/anthropic/v1/messages/count_tokens" : "/anthropic/v1/messages";
    const response = await postJson(app.url, endpoint, { ...request, stream: kind !== "json" });
    await response.text();
    const entry = await waitForLogEntry(app.url, value => value.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry.generation_sample).toBeNull();
    if (kind === "count") expect(entry.output_tokens).toBeNull();
    if (kind === "error" || kind === "incomplete") expect(entry.stream_outcome).not.toBe("success");
  });

  it("does not report a generation sample after the client cancels actual output", async () => {
    const upstream = await startClaudeUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const [envelope, output] = responseFrames("anthropic_messages");
      res.write(envelope + output);
    });
    const app = await startApp(undefined, undefined, { claude: { primary: route(upstream.url, "anthropic_messages") } });
    const controller = new AbortController();
    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(request)
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
    controller.abort();
    await reader.cancel().catch(error => expect(error.name).toBe("AbortError"));
    const entry = await waitForLogEntry(app.url, value => value.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry).toMatchObject({ stream_outcome: "client_cancel", generation_sample: null });
  });

  it("does not infer generation timing when a stream request receives converted JSON", async () => {
    const upstream = await startClaudeUpstream(async (req, res) => {
      await captureBody(req);
      writeJsonResponse(res, {
        id: "chat_sample", object: "chat.completion", model: "synthetic",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 100, total_tokens: 120 }
      });
    });
    const app = await startApp(undefined, undefined, { primary: route(upstream.url, "openai_chat") });
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic", stream: true, input: "synthetic" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ object: "response", status: "completed", output_text: "hello" });
    const entry = await waitForLogEntry(app.url, value => value.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry).toMatchObject({ stream_outcome: "upstream_stream_incomplete", output_tokens: 100, generation_sample: null });
  });
});
