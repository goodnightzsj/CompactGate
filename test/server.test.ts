import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { createCompactGateServer } from "../src/server/http.js";
import type { HealthResponse, PublicConfig, RequestLogEntry } from "../src/shared/types.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface CaptureFixtureRecord {
  route: string;
  source_model: string | null;
  target_model: string | null;
  compact_bridge_replacements: number;
  incoming_request: {
    body: {
      text: string;
    };
  };
  upstream_request: {
    body: {
      text: string;
    };
  };
  upstream_response: {
    body: {
      text: string;
    };
  };
}

const cleanup: Array<() => Promise<void>> = [];
const cleanupEnvKeys = new Set<string>();

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
  for (const key of cleanupEnvKeys) {
    delete process.env[key];
  }
  cleanupEnvKeys.clear();
});

describe("CompactGate HTTP server", () => {
  it("returns health status", async () => {
    const app = await startApp();

    const response = await fetch(`${app.url}/api/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("streams snapshot and pushed log events over SSE", async () => {
    const primary = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);
    const sse = await openSseStream(`${app.url}/api/events`);

    const snapshot = (await sse.waitForEvent("snapshot")) as {
      logs: RequestLogEntry[];
      health: HealthResponse;
      config: PublicConfig;
    };
    expect(snapshot.logs).toEqual([]);
    expect(snapshot.health.status).toBe("ok");
    expect(snapshot.config.listen).toContain("127.0.0.1");

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "stream me" }),
      headers: { "content-type": "application/json" }
    });
    expect(response.status).toBe(200);
    await response.text();

    const logEvent = (await sse.waitForEvent("log")) as {
      entry: RequestLogEntry;
    };
    expect(logEvent.entry).toMatchObject({
      route: "primary",
      source_model: "gpt-5.5",
      target_model: "gpt-5.5",
      status: 200
    });

    await sse.close();
  });

  it("streams primary responses without buffering the upstream body", async () => {
    const primary = await startUpstream((req, res) => {
      captureBody(req).then(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        setTimeout(() => {
          res.end("data: second\n\n");
        }, 5);
      });
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
      headers: { "content-type": "application/json" }
    });

    expect(response.headers.get("x-compactgate-route")).toBe("primary");
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");

    const logsResponse = await fetch(`${app.url}/api/logs/recent`);
    const logsBody = await logsResponse.json();
    expect(logsBody.logs[0]).toMatchObject({
      route: "primary",
      source_model: "gpt-5.5",
      target_model: "gpt-5.5"
    });
  });

  it("logs usage metrics from JSON upstream responses", async () => {
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_usage_json",
          usage: {
            input_tokens: 35213,
            output_tokens: 868,
            input_tokens_details: {
              cached_tokens: 28032
            },
            total_tokens: 64113
          }
        })
      );
    });
    const app = await startApp(primary.url, compact.url);

    const response = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoning: { effort: "xhigh" },
        input: "sensitive prompt"
      }),
      headers: { "content-type": "application/json" }
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
      total_tokens: 64113
    });
    expect(entry.first_token_ms).toEqual(expect.any(Number));
    expect(JSON.stringify(entry)).not.toContain("sensitive prompt");
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
              total_tokens: 15
            }
          }
        })}\n\n`
      );
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        reasoning_effort: "high"
      }),
      headers: { "content-type": "application/json" }
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
      total_tokens: 15
    });
    expect(entry.first_token_ms).toEqual(expect.any(Number));
  });

  it("rewrites compact model and removes stream", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const app = await startApp(primary.url, compact.url);

    const response = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "do not log" }),
      headers: { "content-type": "application/json" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("compact");
    expect(response.headers.get("x-compactgate-model")).toBe("gpt-5.5-openai-compact");
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/responses/compact");
    expect(JSON.parse(captured.current.body)).toEqual({
      model: "gpt-5.5-openai-compact",
      input: "do not log"
    });
  });

  it("logs compact requests without request body content", async () => {
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const app = await startApp(primary.url, compact.url);

    await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4", input: "sensitive prompt" }),
      headers: { "content-type": "application/json" }
    });

    const response = await fetch(`${app.url}/api/logs/recent`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(body.logs[0]).toMatchObject({
      route: "compact",
      status: 200,
      source_model: "gpt-5.4",
      target_model: "gpt-5.4-openai-compact"
    });
    expect(serialized).not.toContain("sensitive prompt");
  });

  it("hot patches config used by subsequent route previews", async () => {
    const app = await startApp();

    const patchResponse = await fetch(`${app.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        compact: {
          base_url: "http://127.0.0.1:55555/v1",
          model_mode: "custom",
          model_override: "manual-compact"
        }
      })
    });
    expect(patchResponse.status).toBe(200);

    const previewResponse = await fetch(`${app.url}/api/test-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/v1/responses/compact",
        body: { model: "gpt-5.5" }
      })
    });
    const preview = await previewResponse.json();

    expect(preview.target_model).toBe("manual-compact");
    expect(preview.upstream_host).toBe("127.0.0.1:55555");
  });

  it("routes compact requests to primary when upstream mode is primary", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "primary" }
    });

    const response = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      headers: { "content-type": "application/json" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("compact");
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/responses/compact");
    expect(JSON.parse(captured.current.body)).toEqual({
      model: "gpt-5.5-openai-compact"
    });

    const logsResponse = await fetch(`${app.url}/api/logs/recent`);
    const logsBody = await logsResponse.json();
    expect(logsBody.logs[0]).toMatchObject({
      route: "compact",
      upstream_host: new URL(primary.url).host,
      source_model: "gpt-5.5",
      target_model: "gpt-5.5-openai-compact"
    });
  });

  it("updates api_key_env names and reports the active credential scope", async () => {
    const app = await startApp(undefined, undefined, {
      compact: {
        upstream_mode: "primary"
      }
    });

    const configResponse = await fetch(`${app.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        primary: { api_key_env: "TEST_PRIMARY_RUNTIME_KEY" },
        compact: { api_key_env: "TEST_COMPACT_RUNTIME_KEY" }
      })
    });
    const configBody = await configResponse.json();

    expect(configResponse.status).toBe(200);
    expect(configBody.primary.api_key_env).toBe("TEST_PRIMARY_RUNTIME_KEY");
    expect(configBody.primary.stored_api_key).toBe(false);
    expect(configBody.primary.active_api_key_env).toBe("TEST_PRIMARY_RUNTIME_KEY");
    expect(configBody.primary.api_key_source).toBe("missing");
    expect(configBody.compact.api_key_env).toBe("TEST_COMPACT_RUNTIME_KEY");
    expect(configBody.compact.stored_api_key).toBe(false);

    const healthResponse = await fetch(`${app.url}/api/health`);
    const healthBody = await healthResponse.json();

    expect(healthBody.compact.api_key_env).toBe("TEST_COMPACT_RUNTIME_KEY");
    expect(healthBody.compact.stored_api_key).toBe(false);
    expect(healthBody.compact.active_credential_scope).toBe("primary");
    expect(healthBody.compact.active_api_key_env).toBe("TEST_PRIMARY_RUNTIME_KEY");
    expect(healthBody.compact.api_key_source).toBe("missing");
  });

  it("prefers saved direct API keys over environment variables without exposing plaintext secrets", async () => {
    const primaryEnv = "PRIMARY_RUNTIME_AUTH_KEY";
    const compactEnv = "COMPACT_RUNTIME_AUTH_KEY";
    setEnv(primaryEnv, "env-primary-key");
    setEnv(compactEnv, "env-compact-key");

    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const compactCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream(async (req, res) => {
      primaryCapture.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream(async (req, res) => {
      compactCapture.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const app = await startApp(primary.url, compact.url, {
      primary: {
        api_key: "saved-primary-key",
        api_key_env: primaryEnv
      },
      compact: {
        api_key: "saved-compact-key",
        api_key_env: compactEnv
      }
    });

    const primaryResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
      headers: { "content-type": "application/json" }
    });
    expect(primaryResponse.status).toBe(200);
    await primaryResponse.text();

    const compactResponse = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
      headers: { "content-type": "application/json" }
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    assertCaptured(primaryCapture.current);
    assertCaptured(compactCapture.current);
    expect(primaryCapture.current.headers.authorization).toBe("Bearer saved-primary-key");
    expect(compactCapture.current.headers.authorization).toBe("Bearer saved-compact-key");

    const configResponse = await fetch(`${app.url}/api/config`);
    const configBody = await configResponse.json();
    const exportResponse = await fetch(`${app.url}/api/config/export`);
    const exportBody = await exportResponse.json();
    const healthResponse = await fetch(`${app.url}/api/health`);
    const healthBody = await healthResponse.json();

    expect(configBody.primary.api_key_source).toBe("config");
    expect(configBody.primary.stored_api_key).toBe(true);
    expect(configBody.primary.active_api_key_env).toBeNull();
    expect("api_key" in configBody.primary).toBe(false);
    expect(configBody.compact.api_key_source).toBe("config");
    expect(configBody.compact.stored_api_key).toBe(true);
    expect(configBody.compact.active_api_key_env).toBeNull();
    expect("api_key" in configBody.compact).toBe(false);
    expect(exportResponse.status).toBe(200);
    expect(exportBody.primary.api_key).toBe("saved-primary-key");
    expect(exportBody.compact.api_key).toBe("saved-compact-key");
    expect(healthBody.primary.api_key_source).toBe("config");
    expect(healthBody.primary.stored_api_key).toBe(true);
    expect(healthBody.compact.api_key_source).toBe("config");
    expect(healthBody.compact.stored_api_key).toBe(true);
    expect(JSON.stringify(configBody)).not.toContain("saved-primary-key");
    expect(JSON.stringify(healthBody)).not.toContain("saved-primary-key");
  });

  it("captures full proxied request and response bodies when enabled", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);

    const primary = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "PRIMARY_CAPTURE_REPLY" }]
            }
          ]
        })
      );
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "capture me fully" }),
      headers: { "content-type": "application/json" }
    });

    expect(response.status).toBe(200);
    await response.text();

    const captures = await waitForCaptureRecords(captureDir, 1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      route: "primary",
      source_model: "gpt-5.5",
      target_model: "gpt-5.5",
      compact_bridge_replacements: 0
    });
    expect(captures[0].incoming_request.body.text).toContain("capture me fully");
    expect(captures[0].upstream_request.body.text).toContain("capture me fully");
    expect(captures[0].upstream_response.body.text).toContain("PRIMARY_CAPTURE_REPLY");
  });

  it("replaces split-mode compaction items with assistant summaries for the primary upstream", async () => {
    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream(async (req, res) => {
      primaryCapture.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
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
        })
      );
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const compactResponse = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "hello split compact" }),
      headers: { "content-type": "application/json" }
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    const primaryResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
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
      }),
      headers: { "content-type": "application/json" }
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
        content: [{ type: "output_text", text: "SUMMARY FROM COMPACT" }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "after compact" }]
      }
    ]);
  });

  it("synthesizes assistant summaries from readable gzip compaction payloads", async () => {
    const summaryText = [
      "- Environment: workspace-write, network restricted, approval policy never.",
      "- User request: reply exactly REUSE_SECOND without tools.",
      "- Current state: no code changes were made in the prior exchange."
    ].join("\n");
    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream(async (req, res) => {
      primaryCapture.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

    const compactResponse = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "hello split compact" }),
      headers: { "content-type": "application/json" }
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    const primaryResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
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
      }),
      headers: { "content-type": "application/json" }
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
    const primary = await startUpstream(async (req, res) => {
      primaryCapture.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const primaryResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
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
      }),
      headers: { "content-type": "application/json" }
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

  it("repairs readable Chinese legacy compaction items without a cached compact response", async () => {
    const summaryText = [
      "- 项目：`/Users/zsj/code/program/CompactGate`。",
      "- 用户请求：分析压缩后 resume 仍然断流的问题。",
      "- 当前结论：这个可读摘要应该转换成 assistant summary message。"
    ].join("\n");
    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream(async (req, res) => {
      primaryCapture.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "split" }
    });

    const primaryResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
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
      }),
      headers: { "content-type": "application/json" }
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

  it("persists recent logs to SQLite across restarts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const firstApp = await startAppInDir(dir, primary.url, compact.url, {
      logging: { keep_recent: 2 }
    });

    await sendCompactRequest(firstApp.url, "gpt-5.3");
    await sendCompactRequest(firstApp.url, "gpt-5.4");
    await sendCompactRequest(firstApp.url, "gpt-5.5");

    const firstLogs = await fetchRecentLogs(firstApp.url);
    expect(firstLogs).toHaveLength(2);
    expect(firstLogs.map((entry) => entry.source_model)).toEqual(["gpt-5.5", "gpt-5.4"]);

    await firstApp.close();

    const restartedApp = await startAppInDir(dir, primary.url, compact.url, {
      logging: { keep_recent: 2 }
    });
    const restartedLogs = await fetchRecentLogs(restartedApp.url);

    expect(restartedLogs).toHaveLength(2);
    expect(restartedLogs.map((entry) => entry.source_model)).toEqual(["gpt-5.5", "gpt-5.4"]);
    expect(JSON.stringify(restartedLogs)).not.toContain("sensitive prompt");
  });

  it("migrates older SQLite log databases with usage metric defaults", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    seedLegacyLogDatabase(path.join(dir, "compactgate-logs.sqlite"));

    const app = await startAppInDir(dir);
    const [entry] = await fetchRecentLogs(app.url);

    expect(entry).toMatchObject({
      route: "compact",
      path: "/v1/responses/compact",
      endpoint: "/responses/compact",
      request_type: "http",
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null
    });
  });
});

async function startApp(
  primaryBaseUrl?: string,
  compactBaseUrl?: string,
  patch?: Record<string, unknown>
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return startAppInDir(dir, primaryBaseUrl, compactBaseUrl, patch);
}

async function startAppInDir(
  dir: string,
  primaryBaseUrl?: string,
  compactBaseUrl?: string,
  patch?: Record<string, unknown>
) {
  const primaryPatch = isRecord(patch?.primary) ? patch.primary : {};
  const compactPatch = isRecord(patch?.compact) ? patch.compact : {};
  const config = await ConfigStore.load(path.join(dir, "compactgate.json"));

  await config.patch({
    ...patch,
    primary: {
      base_url: primaryBaseUrl ?? "http://127.0.0.1:1/v1",
      ...primaryPatch
    },
    compact: {
      base_url: compactBaseUrl ?? "http://127.0.0.1:1/v1",
      ...compactPatch
    }
  });

  const server = createCompactGateServer(config);
  await listen(server);
  const closeServer = trackServer(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: closeServer
  };
}

async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(handler);
  await listen(server);
  trackServer(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`
  };
}

function trackServer(server: http.Server): () => Promise<void> {
  let closed = false;

  const closeServer = async () => {
    if (closed) {
      return;
    }

    closed = true;
    await close(server);
  };

  cleanup.push(closeServer);
  return closeServer;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function captureBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function sendCompactRequest(baseUrl: string, model: string) {
  const response = await fetch(`${baseUrl}/v1/responses/compact`, {
    method: "POST",
    body: JSON.stringify({ model, input: "sensitive prompt" }),
    headers: { "content-type": "application/json" }
  });

  expect(response.status).toBe(200);
}

async function fetchRecentLogs(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/logs/recent`);
  const body = await response.json();
  return body.logs as RequestLogEntry[];
}

function seedLegacyLogDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time TEXT NOT NULL,
        route TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        source_model TEXT,
        target_model TEXT,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        upstream_host TEXT NOT NULL,
        request_id TEXT NOT NULL,
        error_summary TEXT
      );
      CREATE INDEX idx_request_logs_id ON request_logs(id DESC);
    `);
    db.prepare(
      `
        INSERT INTO request_logs (
          time,
          route,
          method,
          path,
          source_model,
          target_model,
          status,
          duration_ms,
          upstream_host,
          request_id,
          error_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      new Date().toISOString(),
      "compact",
      "POST",
      "/v1/responses/compact",
      "gpt-5.5",
      "gpt-5.5-openai-compact",
      200,
      42,
      "legacy.example",
      "legacy-request",
      null
    );
  } finally {
    db.close();
  }
}

async function readCaptureRecords(dir: string) {
  const names = (await readdir(dir)).sort();
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(path.join(dir, name), "utf8")) as CaptureFixtureRecord
    )
  );
}

async function waitForCaptureRecords(dir: string, minCount: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const records = await readCaptureRecords(dir);
    if (records.length >= minCount) {
      return records;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return readCaptureRecords(dir);
}

function setEnv(key: string, value: string) {
  process.env[key] = value;
  cleanupEnvKeys.add(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCaptured(request: CapturedRequest | null): asserts request is CapturedRequest {
  expect(request).not.toBeNull();
}

async function openSseStream(url: string) {
  const target = new URL(url);
  const queue: Array<{ event: string; payload: unknown }> = [];
  const waiters = new Map<
    string,
    Array<{ reject: (error: Error) => void; resolve: (value: unknown) => void }>
  >();
  let buffer = "";
  let response: IncomingMessage | null = null;
  const request = await new Promise<http.ClientRequest>((resolve, reject) => {
    const nextRequest = http.get(target, (incoming) => {
      response = incoming;
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        buffer += chunk;

        while (buffer.includes("\n\n")) {
          const separator = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) {
            continue;
          }

          const pending = waiters.get(parsed.event);
          if (pending && pending.length > 0) {
            pending.shift()?.resolve(parsed.payload);
            continue;
          }

          queue.push(parsed);
        }
      });
      resolve(nextRequest);
    });

    nextRequest.once("error", reject);
  });

  request.on("error", (error) => {
    for (const [, pending] of waiters) {
      for (const waiter of pending) {
        waiter.reject(error);
      }
    }
    waiters.clear();
  });

  cleanup.push(async () => {
    request.destroy();
    response?.destroy();
  });

  return {
    close: async () => {
      request.destroy();
      response?.destroy();
    },
    waitForEvent(event: string, timeoutMs = 1500) {
      const queuedIndex = queue.findIndex((item) => item.event === event);
      if (queuedIndex >= 0) {
        const [queued] = queue.splice(queuedIndex, 1);
        return Promise.resolve(queued.payload);
      }

      return new Promise<unknown>((resolve, reject) => {
        let wrappedResolve: ((value: unknown) => void) | undefined;
        const timeout = setTimeout(() => {
          const pending = waiters.get(event) ?? [];
          waiters.set(
            event,
            pending.filter((waiter) => waiter.resolve !== wrappedResolve)
          );
          reject(new Error(`Timed out waiting for SSE event ${event}.`));
        }, timeoutMs);
        wrappedResolve = (value: unknown) => {
          clearTimeout(timeout);
          resolve(value);
        };
        const wrappedReject = (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        };
        const pending = waiters.get(event) ?? [];
        pending.push({ resolve: wrappedResolve, reject: wrappedReject });
        waiters.set(event, pending);
      });
    }
  };
}

function parseSseFrame(frame: string): { event: string; payload: unknown } | null {
  const lines = frame.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":") || line.length === 0) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    payload: JSON.parse(dataLines.join("\n")) as unknown
  };
}
