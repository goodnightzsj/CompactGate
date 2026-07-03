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

  it("passes standard compact responses through unchanged", async () => {
    const compactBody = {
      id: "resp_compact_standard",
      object: "response.compaction",
      output: [
        {
          type: "compaction",
          encrypted_content: "STANDARD_COMPACT_STATE"
        }
      ]
    };
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream(compactBody);
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "standard compact response"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(compactBody);

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry.compact_response_normalized).toBe(false);
    expect(entry.compact_response_normalize_reason).toBeNull();
    expect(entry.compact_response_synthetic_source).toBeNull();
  });

  it("normalizes successful non-compaction compact responses before returning to clients", async () => {
    const summaryText = [
      "- Repo: `/tmp/example`.",
      "- Current task: keep the restored context available.",
      "- Next action: continue from the compact summary."
    ].join("\n");
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream({
      id: "resp_non_compaction",
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: summaryText }]
        }
      ],
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18
      }
    });
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "normalize this compact response"
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      id: string;
      object: string;
      output: Array<{ type: string; encrypted_content?: string }>;
      usage?: Record<string, unknown>;
    };
    // 方案 B:客户端收原始上游 JSON,归一化仅用于桥接存储。
    expect(body.id).toBe("resp_non_compaction");
    expect(body.object).toBe("response");
    expect(body.output).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summaryText }]
      }
    ]);
    expect(body.usage).toMatchObject({ total_tokens: 18 });

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      compact_response_normalized: true,
      compact_response_normalize_reason: "missing_response_compaction_object",
      compact_response_synthetic_source: "upstream_response",
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18
    });
  });

  it("passes non-200 compact responses through unchanged", async () => {
    const compactBody = {
      id: "resp_non_200_non_compaction",
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "created but not normalized" }]
        }
      ]
    };
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream(compactBody, 201);
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "do not normalize non-200 compact response"
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(compactBody);

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      status: 201,
      compact_response_normalized: false,
      compact_response_normalize_reason: null,
      compact_response_synthetic_source: null
    });
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

  it("normalizes streamed nonstandard compact responses through the split compact host", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const summaryText = "STREAMED COMPACT SUMMARY WITH ENOUGH DETAIL TO BRIDGE";
    const primary = await startUpstream((_req, res) => {
      writeJsonResponse(res, { error: "primary should not receive split compact traffic" }, 500);
    });
    const compact = await startCapturedOpenAiUpstream(captured, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: summaryText })}\n\n`);
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
    // 方案 B:客户端收原始上游 SSE 流(非归一化 JSON)。
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain(summaryText);
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
      total_tokens: 26,
      compact_response_normalized: true,
      compact_response_normalize_reason: "malformed_json",
      compact_response_synthetic_source: "upstream_response"
    });
  });
});
