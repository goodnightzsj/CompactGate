import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertCaptured,
  captureBody,
  type CapturedRequest,
  fetchRecentLogs,
  startApp,
  startUpstream
} from "./helpers/server-test-utils.js";

const JSON_HEADERS = { "content-type": "application/json" };

async function startCapturedOpenAiUpstream(
  target: { current: CapturedRequest | null },
  respond: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
) {
  return startUpstream(async (req, res) => {
    target.current = {
      method: req.method ?? "POST",
      url: req.url ?? "",
      headers: req.headers,
      body: await captureBody(req)
    };
    await respond(req, res);
  });
}

function writeJsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function startJsonUpstream(body: unknown, status = 200) {
  return startUpstream(async (req, res) => {
    await captureBody(req);
    writeJsonResponse(res, body, status);
  });
}

function postJson(appUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: JSON_HEADERS
  });
}

describe("CompactGate OpenAI routing", () => {
  it("logs usage metrics from JSON upstream responses", async () => {
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream({
      id: "resp_usage_json",
      usage: {
        input_tokens: 35213,
        output_tokens: 868,
        input_tokens_details: {
          cached_tokens: 28032
        },
        output_tokens_details: {
          cached_tokens: 120
        },
        total_tokens: 64113
      }
    });
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      reasoning: { effort: "xhigh" },
      input: "sensitive prompt"
    });

    expect(response.status).toBe(200);
    await response.text();

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "compact",
      endpoint: "/responses/compact",
      request_type: "http",
      reasoning_effort: "xhigh",
      input_tokens: 35213,
      output_tokens: 868,
      cached_input_tokens: 28032,
      cached_output_tokens: 120,
      additive_cached_input_tokens: false,
      additive_cached_output_tokens: false,
      total_tokens: 64113
    });
    expect(entry.first_token_ms).toEqual(expect.any(Number));
    expect(entry.incoming_request_body).toBeNull();
    expect(entry.upstream_request_body).toBeNull();
    expect(entry.upstream_response_body).toBeNull();
    expect("cost" in entry).toBe(false);
    expect("billing_mode" in entry).toBe(false);
  });

  it("logs usage metrics from streamed SSE upstream responses", async () => {
    const primary = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
      res.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              input_tokens_details: {
                cached_tokens: 4
              },
              output_tokens_details: {
                cached_tokens: 1
              },
              total_tokens: 15
            }
          }
        })}\n\n`
      );
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      stream: true,
      reasoning_effort: "high"
    });

    expect(response.status).toBe(200);
    await response.text();

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "primary",
      endpoint: "/responses",
      request_type: "stream",
      reasoning_effort: "high",
      input_tokens: 12,
      output_tokens: 3,
      cached_input_tokens: 4,
      cached_output_tokens: 1,
      additive_cached_input_tokens: false,
      additive_cached_output_tokens: false,
      total_tokens: 15
    });
    expect(entry.first_token_ms).toEqual(expect.any(Number));
  });

  it("retries empty-content upstream stream errors before responding", async () => {
    let attempts = 0;
    const primary = await startUpstream(async (req, res) => {
      attempts += 1;
      await captureBody(req);
      if (attempts === 1) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "Stream disconnected before valid content: Stream content validation failed: received 0 chars but content is insufficient",
              type: "upstream_stream_error",
              param: "",
              code: "UPSTREAM_STREAM_ERROR"
            }
          })
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "retry ok" })}`,
          "",
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}`,
          "",
          ""
        ].join("\n")
      );
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      stream: true
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("retry ok");
    expect(attempts).toBe(2);

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "primary",
      status: 200,
      request_type: "stream",
      error_summary: null
    });
  });

  it("retries empty-content upstream stream errors for gzip primary stream requests", async () => {
    let attempts = 0;
    const primary = await startUpstream(async (req, res) => {
      attempts += 1;
      await captureBody(req);
      if (attempts === 1) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "Stream disconnected before valid content: Stream content validation failed: received 0 chars but content is insufficient",
              type: "upstream_stream_error",
              param: "",
              code: "UPSTREAM_STREAM_ERROR"
            }
          })
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "gzip retry ok" })}`,
          "",
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}`,
          "",
          ""
        ].join("\n")
      );
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);
    const requestBody = gzipSync(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      stream: true
    })));

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: requestBody,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip"
      }
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("gzip retry ok");
    expect(attempts).toBe(2);

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "primary",
      status: 200,
      request_type: "stream",
      error_summary: null
    });
  });

  it("rewrites compact model and preserves stream", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startCapturedOpenAiUpstream(captured, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      stream: true,
      input: "do not log"
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("compact");
    expect(response.headers.get("x-compactgate-model")).toBe("gpt-5.5-openai-compact");
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/responses/compact");
    expect(JSON.parse(captured.current.body)).toEqual({
      model: "gpt-5.5-openai-compact",
      stream: true,
      input: "do not log"
    });
  });

  it("accepts gzip compact requests and forwards rewritten plain JSON without stale encoding", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startCapturedOpenAiUpstream(captured, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const app = await startApp(primary.url, compact.url);
    const requestBody = gzipSync(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      input: "compressed compact request"
    })));

    const response = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: requestBody,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("compact");
    expect(response.headers.get("x-compactgate-model")).toBe("gpt-5.5-openai-compact");
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/responses/compact");
    expect(captured.current.headers["content-encoding"]).toBeUndefined();
    expect(captured.current.headers["content-length"]).toBe(String(Buffer.byteLength(captured.current.body)));
    expect(JSON.parse(captured.current.body)).toEqual({
      model: "gpt-5.5-openai-compact",
      stream: true,
      input: "compressed compact request"
    });
  });

  it("passes streamed compact responses through the split compact host", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream((_req, res) => {
      writeJsonResponse(res, { error: "primary should not receive split compact traffic" }, 500);
    });
    const compact = await startCapturedOpenAiUpstream(captured, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
      res.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 21,
              output_tokens: 5,
              total_tokens: 26
            }
          }
        })}\n\n`
      );
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const response = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      stream: true,
      input: "compact stream"
    });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("compact");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"type":"response.output_text.delta"');
    expect(body).toContain('"type":"response.completed"');
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/responses/compact");
    expect(JSON.parse(captured.current.body)).toEqual({
      model: "gpt-5.5-openai-compact",
      stream: true,
      input: "compact stream"
    });

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "compact",
      endpoint: "/responses/compact",
      request_type: "stream",
      upstream_host: new URL(compact.url).host,
      source_model: "gpt-5.5",
      target_model: "gpt-5.5-openai-compact",
      input_tokens: 21,
      output_tokens: 5,
      total_tokens: 26
    });
  });
});
