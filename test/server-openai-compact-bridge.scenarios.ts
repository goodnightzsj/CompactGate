import { gzipSync } from "node:zlib";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  assertCaptured,
  captureBody,
  type CapturedRequest,
  fetchLogPage,
  startApp,
  startUpstream
} from "./helpers/server-test-utils.js";
import { waitForLogEntry } from "./helpers/server-test-logs.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";

const JSON_HEADERS = { "content-type": "application/json" };

type CaptureTarget = CapturedRequest[] | { current: CapturedRequest | null };

async function startCapturedOpenAiUpstream(
  target: CaptureTarget,
  respond: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
) {
  return startUpstream(async (req, res) => {
    const captured = {
      method: req.method ?? "POST",
      url: req.url ?? "",
      headers: req.headers,
      body: await captureBody(req)
    };
    if (Array.isArray(target)) {
      target.push(captured);
    } else {
      target.current = captured;
    }
    await respond(req, res);
  });
}

function writeJsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function postJson(
  appUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = JSON_HEADERS
): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers
  });
}

function postJsonUntilMarkerAndClose(
  appUrl: string,
  path: string,
  body: unknown,
  marker: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  const target = new URL(path, appUrl);
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    let settled = false;
    let statusCode = 0;
    let responseBody = "";
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };
    const req = request(target, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        ...headers,
        "content-length": Buffer.byteLength(payload)
      }
    }, (res) => {
      statusCode = res.statusCode ?? 0;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        responseBody += chunk;
        if (responseBody.includes(marker)) {
          res.destroy();
          settle(() => resolve({ statusCode, body: responseBody }));
        }
      });
      res.on("error", (error) => {
        if (!settled) {
          reject(error);
        }
      });
    });
    req.on("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });
    req.end(payload);
  });
}

function postJsonUntilClosed(
  appUrl: string,
  path: string,
  body: unknown,
  timeoutMs = 1_000
): Promise<{ statusCode: number; body: string; completed: boolean }> {
  const target = new URL(path, appUrl);
  const payload = typeof body === "string" ? body : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    let settled = false;
    let sawResponse = false;
    let responseStatus = 0;
    let responseBody = "";
    const timer = setTimeout(() => {
      settle(() => reject(new Error("Timed out waiting for compact proxy response to close.")));
      req.destroy();
    }, timeoutMs);
    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      finish();
    };
    const req = request(target, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        "content-length": Buffer.byteLength(payload)
      }
    }, (res) => {
      sawResponse = true;
      responseStatus = res.statusCode ?? 0;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        settle(() => resolve({
          statusCode: responseStatus,
          body: responseBody,
          completed: true
        }));
      });
      res.on("aborted", () => {
        settle(() => resolve({
          statusCode: responseStatus,
          body: responseBody,
          completed: false
        }));
      });
      res.on("close", () => {
        if (!res.complete) {
          settle(() => resolve({
            statusCode: responseStatus,
            body: responseBody,
            completed: false
          }));
        }
      });
    });
    req.on("error", (error) => {
      if (settled) {
        return;
      }

      if (sawResponse) {
        settle(() => resolve({
          statusCode: responseStatus,
          body: responseBody,
          completed: false
        }));
        return;
      }

      settle(() => reject(error));
    });
    req.end(payload);
  });
}

describe("CompactGate OpenAI routing", () => {
  it("records V2 compaction as successful when the CLI closes after response.completed", async () => {
    const primary = await startCapturedOpenAiUpstream([], async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write([
        "event: response.completed",
        `data: {"type":"response.completed","response":{"output":"${"x".repeat(70 * 1024)}"}}`,
        "",
        ": completion-tail-marker",
        ""
      ].join("\n"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!res.writableEnded) {
        res.end();
      }
    });
    const compact = await startCapturedOpenAiUpstream([], (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const app = await startApp(primary.url, compact.url);
    const response = await postJsonUntilMarkerAndClose(
      app.url,
      "/v1/responses",
      {
        model: "gpt-5.6-sol",
        stream: true,
        input: [{ type: "compaction_trigger" }]
      },
      "completion-tail-marker",
      {
        "x-codex-beta-features": "remote_compaction_v2",
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "compaction",
          compaction: {
            trigger: "manual",
            implementation: "responses_compaction_v2"
          }
        })
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("response.completed");

    const entry = await waitForLogEntry(
      app.url,
      (candidate) => candidate.path === "/v1/responses" && candidate.route === "compact"
    );
    expect(entry).toMatchObject({
      route: "compact",
      compaction_mode: "remote_v2",
      status: 200,
      upstream_status: 200,
      stream_terminal_event: "response.completed",
      client_disconnect_phase: "after_terminal",
      stream_outcome: "success",
      response_model: null,
      response_model_source: "target_fallback",
      stream_oversized_event_count: 1,
      error_summary: null
    });
  });

  it("expires cached compaction bridge fallback after its bounded lifetime", () => {
    let now = 1_000;
    const scope = {
      compactUpstream: "http://compact.example/v1",
      sourceModel: "gpt-5.5",
      targetModel: "gpt-5.5-openai-compact"
    };
    const store = new CompactionBridgeStore({
      now: () => now,
      ttlMs: 1_000
    });
    const compactResponseBody = Buffer.from(JSON.stringify({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "SUMMARY FROM COMPACT" }]
        },
        {
          type: "compaction",
          encrypted_content: "EXPIRING_COMPACT_STATE"
        }
      ]
    }));
    const followUpBody = Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: [{ type: "compaction", encrypted_content: "EXPIRING_COMPACT_STATE" }]
    }));

    store.storeCompactResponse(compactResponseBody, { scope });
    now += 1_001;

    expect(store.rewritePrimaryBody(followUpBody, scope)).toMatchObject({
      body: followUpBody,
      replacedCompactionCount: 0
    });
  });

  it("expires compact response dedupe entries after the short TTL", () => {
    let now = 1_000;
    const store = new CompactionBridgeStore({
      now: () => now,
      compactDedupeTtlMs: 1_000
    });
    const input = {
      upstream: new URL("http://compact.example/v1/responses"),
      authorization: "Bearer test",
      body: Buffer.from(JSON.stringify({ model: "gpt-5.5-openai-compact", input: "compact me" }))
    };

    store.storeCompactDedupeResponse(input, {
      status: 200,
      responseBody: Buffer.from("{\"ok\":true}"),
      responseHeaders: { "content-type": "application/json" },
      clientResponseBody: Buffer.from("{\"ok\":true}"),
      clientResponseHeaders: { "content-type": "application/json" },
      compactResponseNormalized: false,
      compactResponseNormalizeReason: null,
      compactResponseSyntheticSource: null,
      firstTokenMs: 12
    });

    expect(store.getCachedCompactResponse(input)).toMatchObject({
      status: 200,
      compactResponseNormalized: false,
      firstTokenMs: 12
    });
    now += 1_001;
    expect(store.getCachedCompactResponse(input)).toBeNull();
  });

  it("isolates compact dedupe entries by method and forwarded headers", () => {
    const store = new CompactionBridgeStore();
    const input = {
      method: "POST",
      upstream: new URL("http://compact.example/v1/responses"),
      authorization: "Bearer test",
      requestHeaders: {
        authorization: "Bearer test",
        "openai-project": "project-a"
      },
      body: Buffer.from(JSON.stringify({ model: "gpt-5.5-openai-compact", input: "compact me" }))
    };
    store.storeCompactDedupeResponse(input, {
      status: 200,
      responseBody: Buffer.from("{\"ok\":true}"),
      responseHeaders: { "content-type": "application/json" },
      clientResponseBody: Buffer.from("{\"ok\":true}"),
      clientResponseHeaders: { "content-type": "application/json" },
      compactResponseNormalized: false,
      compactResponseNormalizeReason: null,
      compactResponseSyntheticSource: null,
      firstTokenMs: 12
    });

    expect(store.getCachedCompactResponse({
      ...input,
      method: "GET"
    })).toBeNull();
    expect(store.getCachedCompactResponse({
      ...input,
      requestHeaders: {
        authorization: "Bearer test",
        "openai-project": "project-b"
      }
    })).toBeNull();
    expect(store.getCachedCompactResponse({
      ...input,
      requestHeaders: {
        "openai-project": "project-a",
        authorization: "Bearer test"
      }
    })).not.toBeNull();
  });

  it("does not cache fallback state from oversized gzip compact responses", () => {
    const scope = {
      compactUpstream: "http://compact.example/v1",
      sourceModel: "gpt-5.5",
      targetModel: "gpt-5.5-openai-compact"
    };
    const store = new CompactionBridgeStore();
    const opaqueCompactionState = "A".repeat(120);
    const compactResponseBody = gzipSync(Buffer.from(JSON.stringify({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "oversized summary" }]
        },
        {
          type: "compaction",
          encrypted_content: opaqueCompactionState
        }
      ],
      padding: "x".repeat(9 * 1024 * 1024)
    })));
    const followUpBody = Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: [{ type: "compaction", encrypted_content: opaqueCompactionState }]
    }));

    store.storeCompactResponse(compactResponseBody, { scope });

    expect(store.rewritePrimaryBody(followUpBody, scope)).toMatchObject({
      body: followUpBody,
      replacedCompactionCount: 0
    });
  });

  it("bridges cached compaction fallback directly into primary requests", () => {
    const scope = {
      compactUpstream: "http://compact.example/v1",
      sourceModel: "gpt-5.5",
      targetModel: "gpt-5.5-openai-compact"
    };
    const store = new CompactionBridgeStore();
    const compactResponseBody = Buffer.from(JSON.stringify({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "SUMMARY FROM COMPACT CACHE" }]
        },
        {
          type: "compaction",
          encrypted_content: "CACHED_COMPACT_STATE"
        }
      ]
    }));
    const followUpBody = Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: [
        { type: "compaction", encrypted_content: "CACHED_COMPACT_STATE" },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue after compact" }]
        }
      ]
    }));

    store.storeCompactResponse(compactResponseBody, { scope });

    const rewritten = store.rewritePrimaryBody(followUpBody, scope);
    expect(rewritten.replacedCompactionCount).toBe(1);
    expect(JSON.parse(rewritten.body.toString("utf8")).input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "SUMMARY FROM COMPACT CACHE" }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue after compact" }]
      }
    ]);
  });

  it("isolates cached fallback state by upstream and model scope", () => {
    const cachedScope = {
      compactUpstream: "http://compact-a.example/v1",
      sourceModel: "gpt-5.5",
      targetModel: "gpt-5.5-openai-compact"
    };
    const mismatchedScope = {
      compactUpstream: "http://compact-b.example/v1",
      sourceModel: "gpt-5.5",
      targetModel: "gpt-5.5-openai-compact"
    };
    const store = new CompactionBridgeStore();
    const compactResponseBody = Buffer.from(JSON.stringify({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "SCOPED SUMMARY" }]
        },
        {
          type: "compaction",
          encrypted_content: "SCOPED_COMPACT_STATE"
        }
      ]
    }));
    const followUpBody = Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: [{ type: "compaction", encrypted_content: "SCOPED_COMPACT_STATE" }]
    }));

    store.storeCompactResponse(compactResponseBody, { scope: cachedScope });

    expect(store.rewritePrimaryBody(followUpBody, mismatchedScope)).toMatchObject({
      body: followUpBody,
      replacedCompactionCount: 0
    });

    const rewritten = store.rewritePrimaryBody(followUpBody, cachedScope);
    expect(rewritten.replacedCompactionCount).toBe(1);
    expect(JSON.parse(rewritten.body.toString("utf8")).input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "SCOPED SUMMARY" }]
      }
    ]);
  });

  it("closes compact client responses when the compact upstream aborts after headers", async () => {
    const primary = await startUpstream((_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial compact" })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      res.destroy(new Error("compact upstream aborted after partial response"));
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const response = await postJsonUntilClosed(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      stream: true,
      input: "compact abort after headers"
    });

    // 方案 B:上游 writeHead(200) 被流式转发给客户端,然后 abort。
    // 客户端收到 200 状态码 + SSE 片段,CompactGate 侧日志记 502。
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("partial compact");

    const page = await fetchLogPage(app.url);
    expect(page.logs[0]).toMatchObject({
      route: "compact",
      status: 502,
      error_summary: "Upstream response aborted before completion."
    });
  });

  it("routes the first split-mode compaction follow-up to primary with cached bridge", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      writeJsonResponse(res, {
        object: "response.compaction",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "SUMMARY FROM COMPACT" }]
          },
          {
            type: "compaction",
            encrypted_content: "ENCRYPTED_COMPACT_STATE"
          }
        ]
      });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const compactResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "hello split compact"
    });
    expect(compactResponse.status).toBe(200);
    expect(compactResponse.headers.get("x-compactgate-route")).toBe("compact");
    expect(compactResponse.headers.get("x-compactgate-compaction-mode")).toBe("remote_v1");
    await compactResponse.text();

    const followUpBody = JSON.stringify({
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: "ENCRYPTED_COMPACT_STATE"
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "after compact" }]
        }
      ]
    });
    const primaryResponse = await postJson(app.url, "/v1/responses", followUpBody);

    expect(primaryResponse.status).toBe(200);
    expect(primaryResponse.headers.get("x-compactgate-route")).toBe("primary");
    expect(primaryResponse.headers.get("x-compactgate-compaction-mode")).toBeNull();
    await primaryResponse.text();
    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(1);
    const primaryCapture = primaryRequests[0];
    assertCaptured(primaryCapture);

    const rewrittenBody = JSON.parse(primaryCapture.body) as {
      input: Array<Record<string, unknown>>;
    };
    expect(rewrittenBody.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "SUMMARY FROM COMPACT" }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "after compact" }]
      }
    ]);

    const page = await fetchLogPage(app.url);
    expect(page.logs.slice(0, 2).map((entry) => entry.route)).toEqual([
      "primary",
      "compact"
    ]);
    expect(page.logs[0]).toMatchObject({
      route: "primary",
      compaction_mode: null,
      compaction_detection_source: null,
      endpoint: "/responses",
      upstream_host: new URL(primary.url).host
    });
    expect(page.logs[1]).toMatchObject({
      route: "compact",
      compaction_mode: "remote_v1",
      compaction_detection_source: "path",
      endpoint: "/responses/compact",
      upstream_host: new URL(compact.url).host
    });
  });

  it("routes metadata-only local compaction through compact without changing its SSE response", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { should_not_be_called: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "LOCAL COMPACTION SUMMARY"
        })}\n\n`
      );
      res.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { id: "resp_local_compaction", usage: { input_tokens: 8, output_tokens: 3 } }
        })}\n\n`
      );
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const turnMetadata = JSON.stringify({
      request_kind: "compaction",
      compaction: {
        trigger: "auto",
        reason: "context_window",
        implementation: "responses",
        phase: "standalone_turn"
      }
    });

    const response = await postJson(
      app.url,
      "/v1/responses",
      {
        model: "gpt-5.5",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Summarize this conversation." }]
          }
        ]
      },
      {
        ...JSON_HEADERS,
        "x-codex-turn-metadata": turnMetadata
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("compact");
    const responseText = await response.text();
    expect(responseText).toContain("response.output_text.delta");
    expect(responseText).toContain("LOCAL COMPACTION SUMMARY");
    expect(responseText).toContain("response.completed");

    expect(primaryRequests).toHaveLength(0);
    expect(compactRequests).toHaveLength(1);
    expect(compactRequests[0].url).toBe("/v1/responses");
    expect(compactRequests[0].headers["x-codex-turn-metadata"]).toBe(turnMetadata);
    expect(JSON.parse(compactRequests[0].body)).toMatchObject({
      model: "gpt-5.5-openai-compact",
      stream: true
    });

    const page = await fetchLogPage(app.url);
    expect(page.logs[0]).toMatchObject({
      route: "compact",
      endpoint: "/responses",
      upstream_host: new URL(compact.url).host,
      request_type: "stream",
      compact_response_normalized: false,
      compact_response_normalize_reason: null,
      compact_response_synthetic_source: null
    });
  });

  it("routes remote v2 through primary without compact model rewriting or bridge synthesis", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      const body = JSON.parse(primaryRequests.at(-1)?.body ?? "{}") as { input?: unknown[] };
      if (body.input?.some((item) => typeof item === "object" && item !== null &&
        (item as { type?: unknown }).type === "compaction_trigger")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "compaction",
            encrypted_content: "Readable remote V2 state. Preserve this provider-owned summary."
          }
        })}\n\n`);
        res.end(`data: ${JSON.stringify({
          type: "response.completed",
          response: { id: "resp_remote_v2", usage: { input_tokens: 20, output_tokens: 4 } }
        })}\n\n`);
        return;
      }
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      writeJsonResponse(res, { should_not_be_called: true });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const turnMetadata = JSON.stringify({
      request_kind: "compaction",
      compaction: { trigger: "auto", implementation: "responses_compaction_v2" }
    });

    const triggerResponse = await postJson(
      app.url,
      "/v1/responses",
      {
        model: "gpt-5.5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "conversation to compact" }]
          },
          { type: "compaction_trigger" }
        ],
        client_metadata: { "x-codex-turn-metadata": turnMetadata }
      },
      { ...JSON_HEADERS, "x-codex-turn-metadata": turnMetadata }
    );

    expect(triggerResponse.status).toBe(200);
    expect(triggerResponse.headers.get("x-compactgate-route")).toBe("compact");
    expect(triggerResponse.headers.get("x-compactgate-compaction-mode")).toBe("remote_v2");
    expect(await triggerResponse.text()).toContain("Readable remote V2 state");
    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[0].url).toBe("/v1/responses");
    expect(JSON.parse(primaryRequests[0].body)).toEqual({
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "conversation to compact" }]
        },
        { type: "compaction_trigger" }
      ],
      client_metadata: { "x-codex-turn-metadata": turnMetadata }
    });

    const followUpResponse = await postJson(
      app.url,
      "/v1/responses",
      {
        model: "gpt-5.5",
        input: [
          {
            type: "compaction",
            encrypted_content: "Readable remote V2 state. Preserve this provider-owned summary."
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "continue after body-aware compact" }]
          }
        ]
      },
      { "x-codex-beta-features": "remote_compaction_v2" }
    );

    expect(followUpResponse.status).toBe(200);
    expect(followUpResponse.headers.get("x-compactgate-route")).toBe("primary");
    expect(followUpResponse.headers.get("x-compactgate-compaction-mode")).toBeNull();
    await followUpResponse.text();
    expect(primaryRequests).toHaveLength(2);
    expect(JSON.parse(primaryRequests[1].body).input).toEqual([
      {
        type: "compaction",
        encrypted_content: "Readable remote V2 state. Preserve this provider-owned summary."
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue after body-aware compact" }]
      }
    ]);

    const page = await fetchLogPage(app.url);
    expect(page.logs.slice(0, 2).map((entry) => [entry.route, entry.endpoint])).toEqual([
      ["primary", "/responses"],
      ["compact", "/responses"]
    ]);
    expect(page.logs[0]).toMatchObject({
      route: "primary",
      compaction_mode: null,
      compaction_detection_source: null,
      upstream_host: new URL(primary.url).host,
      compact_response_normalized: false
    });
    expect(page.logs[1]).toMatchObject({
      compaction_mode: "remote_v2",
      compaction_detection_source: "input",
      compact_response_normalized: false
    });
  });

  it("preserves opaque remote v2 state on a normal primary follow-up", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      writeJsonResponse(res, { should_not_be_called: true });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const opaqueState = "Q".repeat(96);

    const response = await postJson(
      app.url,
      "/v1/responses",
      {
        model: "gpt-5.5",
        input: [
          { type: "compaction", encrypted_content: opaqueState },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }
        ]
      },
      { "x-codex-beta-features": "remote_compaction_v2" }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("primary");
    expect(response.headers.get("x-compactgate-compaction-mode")).toBeNull();
    await response.text();
    expect(compactRequests).toHaveLength(0);
    expect(JSON.parse(primaryRequests[0].body).input).toEqual([
      { type: "compaction", encrypted_content: opaqueState },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }
    ]);
  });

  it("reuses identical remote v1 compact responses within the short dedupe TTL", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      writeJsonResponse(res, {
        object: "response.compaction",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "DEDUPED BODY AWARE SUMMARY" }]
          },
          {
            type: "compaction",
            encrypted_content: "DEDUPED_BODY_AWARE_STATE"
          }
        ]
      });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "compaction_trigger",
          content: [{ type: "input_text", text: "dedupe this compact request" }]
        }
      ]
    };

    const firstResponse = await postJson(app.url, "/v1/responses/compact", body);
    const firstRequestId = firstResponse.headers.get("x-compactgate-request-id");
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toMatchObject({
      object: "response.compaction"
    });

    const secondResponse = await postJson(app.url, "/v1/responses/compact", body);
    const secondRequestId = secondResponse.headers.get("x-compactgate-request-id");
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      object: "response.compaction"
    });

    expect(firstRequestId).toBeTruthy();
    expect(secondRequestId).toBeTruthy();
    expect(secondRequestId).not.toBe(firstRequestId);
    expect(compactRequests).toHaveLength(1);
    expect(primaryRequests).toHaveLength(0);

    const followUpResponse = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: "DEDUPED_BODY_AWARE_STATE"
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue after cached compact" }]
        }
      ]
    });
    expect(followUpResponse.status).toBe(200);
    await followUpResponse.text();
    expect(primaryRequests).toHaveLength(1);
    expect(JSON.parse(primaryRequests[0].body).input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "DEDUPED BODY AWARE SUMMARY" }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue after cached compact" }]
      }
    ]);
  });

  it("does not reuse compact responses across OpenAI projects", async () => {
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream([], (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (req, res) => {
      writeJsonResponse(res, {
        object: "response.compaction",
        output: [{
          type: "compaction",
          encrypted_content: `PROJECT_${String(req.headers["openai-project"] ?? "missing")}`
        }]
      });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const body = { model: "gpt-5.5", input: "same compact body" };

    const firstResponse = await postJson(app.url, "/v1/responses/compact", body, {
      ...JSON_HEADERS,
      "OpenAI-Project": "project-a"
    });
    const secondResponse = await postJson(app.url, "/v1/responses/compact", body, {
      ...JSON_HEADERS,
      "OpenAI-Project": "project-b"
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await firstResponse.text();
    await secondResponse.text();
    expect(compactRequests).toHaveLength(2);
  });

  it("does not cache compact SSE responses that close before a terminal event", async () => {
    const compactRequests: CapturedRequest[] = [];
    let responseIndex = 0;
    const primary = await startCapturedOpenAiUpstream([], (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      responseIndex += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (responseIndex === 1) {
        res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
        return;
      }
      res.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const body = { model: "gpt-5.5", stream: true, input: "retry partial compact" };

    const firstResponse = await postJson(app.url, "/v1/responses/compact", body);
    expect(await firstResponse.text()).toContain("partial");
    const secondResponse = await postJson(app.url, "/v1/responses/compact", body);
    expect(await secondResponse.text()).toContain("response.completed");

    expect(compactRequests).toHaveLength(2);
    const page = await fetchLogPage(app.url);
    expect(page.logs.find((entry) => entry.error_summary === "OpenAI stream closed before response.completed."))
      .toMatchObject({ route: "compact", status: 200 });
  });

  it("caches valid JSON compact responses when the request asked for streaming", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      writeJsonResponse(res, {
        object: "response.compaction",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "JSON STREAM FALLBACK SUMMARY" }]
          },
          {
            type: "compaction",
            encrypted_content: "JSON_STREAM_FALLBACK_STATE"
          }
        ]
      });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const compactBody = {
      model: "gpt-5.5",
      stream: true,
      input: "cache a JSON response"
    };

    const firstResponse = await postJson(app.url, "/v1/responses/compact", compactBody);
    const secondResponse = await postJson(app.url, "/v1/responses/compact", compactBody);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await firstResponse.text();
    await secondResponse.text();
    expect(compactRequests).toHaveLength(1);

    const followUpResponse = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [{ type: "compaction", encrypted_content: "JSON_STREAM_FALLBACK_STATE" }]
    });
    expect(followUpResponse.status).toBe(200);
    await followUpResponse.text();
    expect(JSON.parse(primaryRequests[0].body).input).toEqual([{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "JSON STREAM FALLBACK SUMMARY" }]
    }]);

    const page = await fetchLogPage(app.url);
    const compactLogs = page.logs.filter((entry) => entry.route === "compact");
    expect(compactLogs).toHaveLength(2);
    expect(compactLogs.every((entry) => entry.error_summary === null)).toBe(true);
  });

  it("does not dedupe different compact request bodies", async () => {
    const compactRequests: CapturedRequest[] = [];
    let responseIndex = 0;
    const primary = await startCapturedOpenAiUpstream([], (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      responseIndex += 1;
      writeJsonResponse(res, {
        object: "response.compaction",
        output: [
          {
            type: "compaction",
            encrypted_content: `DIFFERENT_BODY_STATE_${responseIndex}`
          }
        ]
      });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const firstResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: [{ type: "compaction_trigger", content: [{ type: "input_text", text: "first" }] }]
    });
    const secondResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: [{ type: "compaction_trigger", content: [{ type: "input_text", text: "second" }] }]
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await firstResponse.text();
    await secondResponse.text();
    expect(compactRequests).toHaveLength(2);
  });

  it("does not cache failed compact responses", async () => {
    const compactRequests: CapturedRequest[] = [];
    let responseIndex = 0;
    const primary = await startCapturedOpenAiUpstream([], (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      responseIndex += 1;
      if (responseIndex === 1) {
        writeJsonResponse(res, { error: "temporary compact failure" }, 500);
        return;
      }

      writeJsonResponse(res, {
        object: "response.compaction",
        output: [
          {
            type: "compaction",
            encrypted_content: "RECOVERED_COMPACT_STATE"
          }
        ]
      });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const body = {
      model: "gpt-5.5",
      input: [{ type: "compaction_trigger", content: [{ type: "input_text", text: "retry compact" }] }]
    };

    const failedResponse = await postJson(app.url, "/v1/responses/compact", body);
    const recoveredResponse = await postJson(app.url, "/v1/responses/compact", body);

    expect(failedResponse.status).toBe(500);
    expect(recoveredResponse.status).toBe(200);
    await failedResponse.text();
    await recoveredResponse.text();
    expect(compactRequests).toHaveLength(2);
  });

  it("bridges locally normalized compact responses into primary requests", async () => {
    const summaryText = [
      "- Local synthetic compact summary.",
      "- The compact upstream returned a normal response instead of response.compaction.",
      "- The next primary request should receive this as an assistant message."
    ].join("\n");
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      writeJsonResponse(res, {
        id: "resp_local_normalized",
        object: "response",
        output_text: summaryText
      });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const compactResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "hello synthetic compact"
    });
    expect(compactResponse.status).toBe(200);
    // 方案 B:客户端收原始上游流(非归一化 JSON),归一化仅用于桥接存储。
    const compactBody = await compactResponse.json() as { output_text?: string };
    expect(compactBody.output_text).toBe(summaryText);

    const primaryResponse = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: summaryText
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "after synthetic compact" }]
        }
      ]
    });

    expect(primaryResponse.status).toBe(200);
    await primaryResponse.text();
    expect(compactRequests).toHaveLength(1);
    expect(primaryRequests).toHaveLength(1);
    expect(JSON.parse(primaryRequests[0].body).input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summaryText }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "after synthetic compact" }]
      }
    ]);

    const page = await fetchLogPage(app.url);
    expect(page.logs[1]).toMatchObject({
      route: "compact",
      compact_response_normalized: true,
      compact_response_normalize_reason: "missing_compaction_output",
      compact_response_synthetic_source: "upstream_response"
    });
  });

  it("does not reuse cached compaction state after the compact upstream changes", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const firstCompactRequests: CapturedRequest[] = [];
    const secondCompactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const firstCompact = await startCapturedOpenAiUpstream(firstCompactRequests, (_req, res) => {
      writeJsonResponse(res, {
        object: "response.compaction",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "SUMMARY FROM FIRST COMPACT" }]
          },
          {
            type: "compaction",
            encrypted_content: "SHARED_COMPACT_STATE"
          }
        ]
      });
    });
    const secondCompact = await startCapturedOpenAiUpstream(secondCompactRequests, (_req, res) => {
      writeJsonResponse(res, { should_not_be_called: true });
    });
    const app = await startApp(primary.url, firstCompact.url, {
      compact: { upstream_mode: "split" }
    });

    const compactResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "cache compact state"
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    const patchResponse = await fetch(`${app.url}/api/config`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        compact: {
          base_url: secondCompact.url,
          upstream_mode: "split"
        }
      })
    });
    expect(patchResponse.status).toBe(200);

    const followUpBody = {
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: "SHARED_COMPACT_STATE"
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "after compact switch" }]
        }
      ]
    };
    const followUpResponse = await postJson(app.url, "/v1/responses", followUpBody);

    expect(followUpResponse.status).toBe(422);
    expect(await followUpResponse.json()).toMatchObject({
      error: expect.stringContaining("could not bridge into a primary request")
    });
    expect(firstCompactRequests).toHaveLength(1);
    expect(secondCompactRequests).toHaveLength(0);
    expect(primaryRequests).toHaveLength(0);
  });

  it("synthesizes assistant summaries from readable gzip compaction payloads", async () => {
    const summaryText = [
      "- Environment: workspace-write, network restricted, approval policy never.",
      "- User request: reply exactly REUSE_SECOND without tools.",
      "- Current state: no code changes were made in the prior exchange."
    ].join("\n");
    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startCapturedOpenAiUpstream(primaryCapture, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startUpstream(async (req, res) => {
      await captureBody(req);
      const payload = gzipSync(
        JSON.stringify({
          output: [{ type: "compaction", encrypted_content: summaryText }]
        })
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(payload.byteLength)
      });
      res.end(payload);
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const compactResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "hello split compact"
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    const followUpBody = JSON.stringify({
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: summaryText
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "after compact" }]
        }
      ]
    });
    const primaryResponse = await postJson(app.url, "/v1/responses", followUpBody);

    expect(primaryResponse.status).toBe(200);
    expect(primaryResponse.headers.get("x-compactgate-route")).toBe("primary");
    assertCaptured(primaryCapture.current);

    const rewrittenBody = JSON.parse(primaryCapture.current.body) as {
      input: Array<Record<string, unknown>>;
    };
    expect(rewrittenBody.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summaryText }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "after compact" }]
      }
    ]);
  });

  it("repairs readable legacy compaction items without a cached compact response", async () => {
    const summaryText = [
      "- Legacy compact summary from an earlier session.",
      "- This request reached the proxy after restart, so there is no cached compact mapping.",
      "- The proxy should still translate this into an assistant summary message."
    ].join("\n");
    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startCapturedOpenAiUpstream(primaryCapture, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const primaryResponse = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: summaryText
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue old session" }]
        }
      ]
    });

    expect(primaryResponse.status).toBe(200);
    assertCaptured(primaryCapture.current);

    const rewrittenBody = JSON.parse(primaryCapture.current.body) as {
      input: Array<Record<string, unknown>>;
    };
    expect(rewrittenBody.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summaryText }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue old session" }]
      }
    ]);
  });

  it("drops stale gzip encoding headers when compaction bridge rewrites primary bodies to plain JSON", async () => {
    const summaryText = [
      "- Legacy compact summary from an earlier session.",
      "- This gzip request reached the proxy after restart.",
      "- The proxy should translate it into an assistant summary message."
    ].join("\n");
    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startCapturedOpenAiUpstream(primaryCapture, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });
    const requestBody = gzipSync(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: summaryText
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue old session" }]
        }
      ]
    })));

    const primaryResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip"
      },
      body: requestBody
    });

    expect(primaryResponse.status).toBe(200);
    expect(primaryResponse.headers.get("x-compactgate-route")).toBe("primary");
    assertCaptured(primaryCapture.current);
    expect(primaryCapture.current.headers["content-encoding"]).toBeUndefined();
    expect(primaryCapture.current.headers["content-length"]).toBe(String(Buffer.byteLength(primaryCapture.current.body)));

    const rewrittenBody = JSON.parse(primaryCapture.current.body) as {
      input: Array<Record<string, unknown>>;
    };
    expect(rewrittenBody.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summaryText }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue old session" }]
      }
    ]);
  });

  it("repairs readable Chinese legacy compaction items without a cached compact response", async () => {
    const summaryText = [
      "- 项目：`/Users/zsj/code/program/CompactGate`。",
      "- 用户请求：分析压缩后 resume 仍然断流的问题。",
      "- 当前结论：这个可读摘要应该转换成 assistant summary message。"
    ].join("\n");
    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startCapturedOpenAiUpstream(primaryCapture, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const primaryResponse = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: summaryText
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue old session" }]
        }
      ]
    });

    expect(primaryResponse.status).toBe(200);
    assertCaptured(primaryCapture.current);

    const rewrittenBody = JSON.parse(primaryCapture.current.body) as {
      input: Array<Record<string, unknown>>;
    };
    expect(rewrittenBody.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summaryText }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue old session" }]
      }
    ]);
  });

  it("bridges streamed output_item.done compact payloads into primary follow-ups", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "SSE ITEM DONE SUMMARY" }]
          }
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "compaction",
            encrypted_content: "OPAQUE_SSE_COMPACT_STATE_1234567890"
          }
        })}\n\n`
      );
      res.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 9,
              output_tokens: 4,
              total_tokens: 13
            }
          }
        })}\n\n`
      );
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const compactResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      stream: true,
      input: "streamed item done compact"
    });

    expect(compactResponse.status).toBe(200);
    // 方案 B:客户端收原始 SSE 流(非归一化 JSON),验证关键事件。
    const compactText = await compactResponse.text();
    expect(compactText).toContain("SSE ITEM DONE SUMMARY");
    expect(compactText).toContain("OPAQUE_SSE_COMPACT_STATE_1234567890");
    expect(compactText).toContain("response.completed");

    const followUpResponse = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: "OPAQUE_SSE_COMPACT_STATE_1234567890"
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue after streamed compact" }]
        }
      ]
    });

    expect(followUpResponse.status).toBe(200);
    await followUpResponse.text();
    expect(compactRequests).toHaveLength(1);
    expect(primaryRequests).toHaveLength(1);
    expect(JSON.parse(primaryRequests[0].body).input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "SSE ITEM DONE SUMMARY" }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue after streamed compact" }]
      }
    ]);

    const page = await fetchLogPage(app.url);
    expect(page.logs[1]).toMatchObject({
      route: "compact",
      request_type: "stream",
      compact_response_normalized: true,
      compact_response_normalize_reason: "malformed_json",
      compact_response_synthetic_source: "upstream_response",
      input_tokens: 9,
      output_tokens: 4,
      total_tokens: 13
    });
  });

  it("preserves the Remote V1 bridge when the client closes after terminal SSE", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "DELAYED V1 SUMMARY" }]
        }
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "compaction",
          encrypted_content: "DELAYED_V1_STATE"
        }
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "response.completed",
        response: {
          model: "gpt-5.5-v1-response",
          usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 }
        }
      })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!res.writableEnded) {
        res.end();
      }
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const compactResponse = await postJsonUntilMarkerAndClose(
      app.url,
      "/v1/responses/compact",
      { model: "gpt-5.5", stream: true, input: "delayed v1 compact" },
      "response.completed",
      {}
    );
    expect(compactResponse.statusCode).toBe(200);
    expect(compactRequests).toHaveLength(1);

    const followUpResponse = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [
        { type: "compaction", encrypted_content: "DELAYED_V1_STATE" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }
      ]
    });
    expect(followUpResponse.status).toBe(200);
    await followUpResponse.text();
    expect(primaryRequests).toHaveLength(1);
    expect(JSON.parse(primaryRequests[0].body).input[0]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "DELAYED V1 SUMMARY" }]
    });

    const compactLog = await waitForLogEntry(
      app.url,
      (candidate) => candidate.route === "compact" && candidate.compaction_mode === "remote_v1"
    );
    expect(compactLog).toMatchObject({
      status: 200,
      upstream_status: 200,
      stream_terminal_event: "response.completed",
      client_disconnect_phase: "after_terminal",
      stream_outcome: "success",
      response_model: "gpt-5.5-v1-response",
      response_model_source: "upstream",
      error_summary: null
    });
  });
});
