import { describe, expect, it } from "vitest";
import { extractResponseModelFromText } from "../src/server/response-model.js";
import { createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";
import { applyOpenAiProxyUpstreamResult, createOpenAiProxyTransactionState } from "../src/server/openai-proxy-transaction.js";
import {
  captureBody, postJson, startApp, startUpstream, waitForLogEntry
} from "./helpers/server-test-utils.js";

describe("response model across SSE framing", () => {
  it.each(["\n", "\r\n", "\r"])("uses the last event field with %j line endings", async newline => {
    const wire = ['event: response.completed', 'event: response.created',
      'data: {"type":"response.created","response":{"model":"provisional"}}', '',
      'event: response.completed', 'data: {"type":"response.completed","response":{"model":"actual"}}', '', ''].join(newline);
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" })!;
    observer.observe(Buffer.from(wire));
    expect((await observer.finish()).responseModel).toBe("actual");
    expect(extractResponseModelFromText(wire)).toBe("actual");
  });

  it("preserves a named multiline completion over later metadata", () => {
    expect(extractResponseModelFromText('event: response.completed\r\ndata: {"response":\r\ndata: {"model":"actual"}}\r\n\r\n'
      + 'data: {"model":"late"}\n\n')).toBe("actual");
  });

  it("settles the upstream declaration when the translated client reports another model", async () => {
    const responseHeaders = { "content-type": "text/event-stream" };
    const observe = async (model: string) => {
      const observer = createOpenAiStreamObserver(responseHeaders)!;
      observer.observe(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { model } })}\n\n`));
      return observer.finish();
    };
    const state = createOpenAiProxyTransactionState();
    applyOpenAiProxyUpstreamResult(state, { status: 200, errorSummary: null, responseBody: Buffer.from(""), responseHeaders,
      responseBodyTruncated: true, firstTokenMs: null, clientDisconnectPhase: "none",
      streamSummary: await observe("upstream-declaration"), clientStreamSummary: await observe("translated-alias") });
    expect(state.responseModel).toBe("upstream-declaration");
  });
  it.each([0, 140])("keeps the final declared model after %s diagnostic padding frames", async paddingFrames => {
    const start = 'event: response.created\ndata: {"type":"response.created","response":{"model":"synthetic-provisional-model"}}\n\n';
    const end = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_synthetic_r6","status":"completed","model":"synthetic-declared-model","output":[],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n';
    const padding = ": " + "x".repeat(65530) + "\n\n";
    const wire = start + padding.repeat(paddingFrames) + end;
    expect(Buffer.byteLength(wire)).toBeLessThan(20 * 1024 * 1024);
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(wire);
    });
    const app = await startApp(upstream.url);
    const response = await postJson(app.url, "/v1/responses", {
      model: "synthetic-requested-model", input: "synthetic", stream: true
    });
    expect(response.status).toBe(200);
    const delivered = await response.text();
    expect(delivered.length).toBe(wire.length);
    expect(delivered.endsWith(end)).toBe(true);
    const entry = await waitForLogEntry(app.url, log =>
      log.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry).toMatchObject({
      stream_outcome: "success", input_tokens: 10, output_tokens: 5,
      upstream_response_truncated: paddingFrames > 0
    });
    expect(entry).toMatchObject({ response_model: "synthetic-declared-model", response_model_source: "upstream" });
  });

  it.each([
    ["/v1/responses", false],
    ["/v1/responses", true],
    ["/v1/responses/compact", false],
    ["/v1/responses/compact", true]
  ] as const)("keeps declared model on %s, multiline=%s", async (endpoint, multiline) => {
    const responsePayload = {
      id: "resp_synthetic_r6", status: "completed", model: "synthetic-declared-model",
      output: endpoint.endsWith("/compact")
        ? [{ type: "compaction", encrypted_content: "synthetic-only" }] : [],
      usage: { input_tokens: 10, output_tokens: 5 }
    };
    const event = multiline
      ? `data: {"type":"response.completed",\ndata: "response":${JSON.stringify(responsePayload)}}\n\n`
      : `data: ${JSON.stringify({ type: "response.completed", response: responsePayload })}\n\n`;
    const wire = "event: response.completed\n" + event;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(wire);
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary: { api_key: "synthetic-only", api_key_env: "" },
      compact: { api_key: "synthetic-only", api_key_env: "", model_mode: "custom", model_override: "synthetic-requested-model" }
    });
    const response = await postJson(app.url, endpoint, {
      model: "synthetic-requested-model", input: "synthetic", stream: true
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(wire);
    const entry = await waitForLogEntry(app.url, log =>
      log.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry).toMatchObject({ stream_outcome: "success", input_tokens: 10, output_tokens: 5 });
    expect(entry).toMatchObject({
      response_model: "synthetic-declared-model",
      response_model_source: "upstream",
      effective_response_model: "synthetic-declared-model"
    });
  });
});
