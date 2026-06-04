import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { createCompactGateServer } from "../src/server/http.js";
import type {
  HealthResponse,
  PublicConfig,
  RequestLogEntry,
  RequestLogPage
} from "../src/shared/types.js";

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
    headers: Record<string, string | string[]>;
    body: {
      text: string;
    };
  };
  upstream_request: {
    headers: Record<string, string | string[]>;
    body: {
      text: string;
    };
  };
  upstream_response: {
    headers: Record<string, string | string[]>;
    status: number;
    body: {
      text: string;
    };
  };
}

const cleanup: Array<() => Promise<void>> = [];
const cleanupEnvKeys = new Set<string>();

const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUcvV/TjjQFzWxMvFCvvxpjpYTOtcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDYwMjA3NDYyM1oXDTM2MDUz
MDA3NDYyM1owFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAwaayjtPWSragAr6w2Asx7DAc9xqWHun4ICnVuN6cpk7g
KE8BDatJPQsP4RpbWCMFKSK6iJxtkeRsrDi4ZH22JlJyZMQnmuT/kgFl+phwKs5H
GptdUVAdf6bcazo8B+D8DjwOd5cP4DXuGmJU08I+B+mNMQscp/7kINJrgWSWMIKG
PeZF13E7wzMTfqu4VUNNKM4eT6FiTcF9mmqhANuIduoXKRlvoyZea/MxeNEIWFKJ
8uFfMqV4KbT6RlnadelMPblnD7XNC+pYl6iCLlpPrrnmFZ4I4rB57bnlwKulKxts
qz8trARN8Q/978EqaA/6x3ImWSwxtFyx1m4Tok3YrQIDAQABo28wbTAdBgNVHQ4E
FgQUzI7An9f7V0ZscvYQhOLmOTOSJBcwHwYDVR0jBBgwFoAUzI7An9f7V0ZscvYQ
hOLmOTOSJBcwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAEj4/aYDzmsm1rFXixA4opMHu6yr7Ml2
qxVrFGFn/4P84I7SBucldUQYTRpVuQW8pXCB2EI7i346E66jEJkZvfxM+AWarH2v
bWxJC9CBe36cqzkagZA0V/f/qMauGcrKmwmR+c1TQk3YxBxXeUO2OV6il1K4C2wE
qwiZPBgDcCqBgukh1zC9rThM/+qpUZ9LGANG7S6z4pFoQT1tiItpkVOIMbDc6Bkk
WuL99F82v365Y+rd512XUU+w7Q2IsGdYTxJxgwjd+yy24Bp7kDtp9ePf0s200WcQ
5p+XzWJ868QLSM4k9ZljNcOphBik0WfLS7KEDcOoQKLzg+3az5/COSw=
-----END CERTIFICATE-----`;

const LOCALHOST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDBprKO09ZKtqAC
vrDYCzHsMBz3GpYe6fggKdW43pymTuAoTwENq0k9Cw/hGltYIwUpIrqInG2R5Gys
OLhkfbYmUnJkxCea5P+SAWX6mHAqzkcam11RUB1/ptxrOjwH4PwOPA53lw/gNe4a
YlTTwj4H6Y0xCxyn/uQg0muBZJYwgoY95kXXcTvDMxN+q7hVQ00ozh5PoWJNwX2a
aqEA24h26hcpGW+jJl5r8zF40QhYUony4V8ypXgptPpGWdp16Uw9uWcPtc0L6liX
qIIuWk+uueYVngjisHntueXAq6UrG2yrPy2sBE3xD/3vwSpoD/rHciZZLDG0XLHW
bhOiTditAgMBAAECggEADVlWDQhx84aGnd8n8PdHQrZyWLT+zN9orkw+olbIyky8
9lUJMo2wfRe/yXmipam3AltAK930o6Obu3zRdoPqmYECHQt0hiCWXtSKg21yAKa6
5LekWtBAqFBdThBJRmsY6kueMlo5yu/iG57UUCCfXAuaeFtWvLHnvJIkvQUCYWeP
RT//Aq/BVlukpFcZHbCRA5oiBSlFa0E9TbXm24zkFZsWRGOWjlz1EwWu8btnFkyK
bc6XF/g7xUdLNhFgGG+rZwvpUeEi7Lox+lqpBEc0I4VQ2KolV6rBqlhyskrXHrkk
ULD8Y6ac3QXukOyM/BeCilAGgjIYKHyvLZxGFOq7gQKBgQDkRPuuCQ0xGDTJ3ZVS
KvXXYAwebwaEjvxROP02Fi98H0Vvf65TNWVsAxqTsmJ9WvRggTYT+h+LLP7k0Kqd
TP2x75s4eRvxMbvzKWn5Qps9pAUTyRTzZgrXRbkrinS6uiOmTzROx+VItWmNG90Y
PJRt3QcYpUhFiabpEn1SNL7q4QKBgQDZLRwkeGJqdy6zGvQ0ELUU/QiglebvspGJ
mYP5+UmQU/zpH0/INNAIfeIU3UlXnDS8OmY98rELcdZMnQjRuyIMp7o9S65Yaaw2
Xcsymj9gnbExYuZ4RF8kdFEPIbVo3rJujg/Vd5+uRUuIhb3FB4JaNZUcMl+WHUBV
brnwVkKTTQKBgA7B+veEdErhQsBuR/IY/u3essng6a32RI/HvG8bvhQrPWT4/z83
64exJ6220bFDCRuYHvPprtJjpVMLvowO5zPyxrk+8zSDv5/35HcN/FVe3kkqLeWS
ik7inhcXi3ZrBFUDN+GEAOnTeLB7xa6EdCAqMwQ/401Dmfvlix6edF1hAoGAV6nD
0FzfrQYKzbU1mcacsaopz1hy7ZJw+NAE2+Rqc13Tmu5OsAvRZXwaxD1Gm5ysFMal
+p96I5qB3E8O/knBRsZ1gMSJzZpqL0/Q884bgw5kNgEr8qP2m6pwBeGfboNmFwY1
Ef/Fbvz9rk/9+Ag979ftJoKW3utTyqh1WbQYD4kCgYEAimAJEHJNlsCMFfALymHQ
cDa3oOTe560OUapG+lMG8Khj3HVb42M+2JMnUUn4kKtkLyuL8gQDguStUz6FnBL4
2XfxAIpGNxXK9GclMyVfFgx1dCRfI0P3CPuWqrN086PE+vb5ozylSDva1r7SM3Ch
+APJjlcSazs6nqL9uAvWzzI=
-----END PRIVATE KEY-----`;

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
            output_tokens_details: {
              cached_tokens: 120
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
      cached_output_tokens: 120,
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
      cached_output_tokens: 1,
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
      res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "retry ok" })}\n\n`);
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      headers: { "content-type": "application/json" }
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

  it("rewrites compact model and preserves stream", async () => {
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
      stream: true,
      input: "do not log"
    });
  });

  it("passes streamed compact responses through the split compact host", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "primary should not receive split compact traffic" }));
    });
    const compact = await startUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
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

    const response = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "compact stream" }),
      headers: { "content-type": "application/json" }
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
      headers: {
        "content-type": "application/json",
        "user-agent": "CompactGateTest/1.0"
      }
    });

    const response = await fetch(`${app.url}/api/logs/recent`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(body.logs[0]).toMatchObject({
      route: "compact",
      status: 200,
      source_model: "gpt-5.4",
      target_model: "gpt-5.4-openai-compact",
      user_agent: "CompactGateTest/1.0"
    });
    expect(serialized).not.toContain("sensitive prompt");
  });

  it("returns faceted route, status, and host counts with upstream error summaries", async () => {
    const primary = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "bad compact model",
            type: "invalid_request_error"
          }
        })
      );
    });
    const claude = await startClaudeUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const app = await startApp(primary.url, compact.url, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const primaryResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "do not expose" }),
      headers: { "content-type": "application/json" }
    });
    expect(primaryResponse.status).toBe(200);
    await primaryResponse.text();

    const compactResponse = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "do not expose" }),
      headers: { "content-type": "application/json" }
    });
    expect(compactResponse.status).toBe(400);
    await compactResponse.text();

    const claudeResponse = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "do not expose" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });
    expect(claudeResponse.status).toBe(200);
    await claudeResponse.text();

    const allPage = await fetchLogPage(app.url);
    expect(allPage.total).toBe(3);
    expect(allPage.counts).toEqual({
      all: 3,
      primary: 1,
      compact: 1,
      claude: 1
    });
    expect(allPage.status_counts).toEqual({
      all: 3,
      normal: 2,
      error: 1
    });

    const errorPage = await fetchLogPage(app.url, "?status=error");
    expect(errorPage.logs).toHaveLength(1);
    expect(errorPage.logs[0]).toMatchObject({
      route: "compact",
      status: 400,
      error_summary: "Upstream returned HTTP 400: bad compact model (invalid_request_error)",
      request_summary: "input text"
    });
    expect(errorPage.counts).toEqual({
      all: 1,
      primary: 0,
      compact: 1,
      claude: 0
    });
    expect(errorPage.status_counts).toEqual({
      all: 3,
      normal: 2,
      error: 1
    });
    expect(errorPage.host_counts).toEqual([
      {
        host: new URL(compact.url).host,
        total: 1,
        primary: 0,
        compact: 1,
        claude: 0
      }
    ]);

    const primaryHostParams = new URLSearchParams({ host: new URL(primary.url).host });
    const primaryHostPage = await fetchLogPage(app.url, `?${primaryHostParams.toString()}`);
    expect(primaryHostPage.logs).toHaveLength(1);
    expect(primaryHostPage.counts).toEqual({
      all: 1,
      primary: 1,
      compact: 0,
      claude: 0
    });
    expect(primaryHostPage.status_counts).toEqual({
      all: 1,
      normal: 1,
      error: 0
    });
    expect(primaryHostPage.host_counts.map((entry) => entry.host).sort()).toEqual(
      [new URL(primary.url).host, new URL(compact.url).host, new URL(claude.url).host].sort()
    );

    const normalPrimaryHostParams = new URLSearchParams({
      status: "normal",
      host: new URL(primary.url).host
    });
    const normalPrimaryHostPage = await fetchLogPage(
      app.url,
      `?${normalPrimaryHostParams.toString()}`
    );
    expect(normalPrimaryHostPage.logs).toHaveLength(1);
    expect(normalPrimaryHostPage.counts).toEqual({
      all: 1,
      primary: 1,
      compact: 0,
      claude: 0
    });
    expect(normalPrimaryHostPage.host_counts.map((entry) => entry.host).sort()).toEqual(
      [new URL(primary.url).host, new URL(claude.url).host].sort()
    );
    expect(JSON.stringify(allPage)).not.toContain("do not expose");
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

  it("saves and applies config profiles through the public API", async () => {
    const app = await startApp();

    const saveResponse = await fetch(`${app.url}/api/config/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Profile API",
        config: {
          primary: {
            base_url: "http://127.0.0.1:56001/v1",
            api_key: "profile-api-primary-key"
          },
          compact: {
            base_url: "http://127.0.0.1:56002/v1",
            api_key: "profile-api-compact-key",
            upstream_mode: "split",
            model_mode: "custom",
            model_override: "profile-api-compact-model"
          },
          claude: {
            primary: {
              base_url: "http://127.0.0.1:56003",
              api_key: "profile-api-claude-primary-key"
            },
            compact: {
              base_url: "http://127.0.0.1:56004",
              api_key: "profile-api-claude-compact-key"
            }
          }
        }
      })
    });
    const savedConfig = (await saveResponse.json()) as PublicConfig;

    expect(saveResponse.status).toBe(200);
    expect(savedConfig.profiles).toHaveLength(1);
    expect(savedConfig.profiles[0]).toMatchObject({
      scope: "codex",
      name: "Profile API",
      primary_host: "127.0.0.1:56001",
      compact_host: "127.0.0.1:56002",
      claude_primary_host: null,
      claude_compact_host: null,
      compact_upstream_mode: "split",
      claude_compact_upstream_mode: null,
      stored_api_key_count: 2
    });
    expect(savedConfig.active_profile_id).toBeNull();
    expect(JSON.stringify(savedConfig)).not.toContain("profile-api-primary-key");
    expect(JSON.stringify(savedConfig)).not.toContain("profile-api-claude-compact-key");

    const profileId = savedConfig.profiles[0].id;
    const listResponse = await fetch(`${app.url}/api/config/profiles`);
    const listedProfiles = (await listResponse.json()) as Pick<PublicConfig, "profiles" | "active_profile_id">;

    expect(listResponse.status).toBe(200);
    expect(listedProfiles.profiles).toHaveLength(1);
    expect(listedProfiles.profiles[0]).toMatchObject({
      id: profileId,
      name: "Profile API"
    });
    expect(listedProfiles.active_profile_id).toBeNull();
    expect(JSON.stringify(listedProfiles)).not.toContain("profile-api-primary-key");
    expect(JSON.stringify(listedProfiles)).not.toContain("profile-api-claude-compact-key");

    const applyResponse = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile_id: profileId })
    });
    const appliedConfig = (await applyResponse.json()) as PublicConfig;

    expect(applyResponse.status).toBe(200);
    expect(appliedConfig.active_profile_id).toBe(profileId);
    expect(appliedConfig.primary.base_url).toBe("http://127.0.0.1:56001/v1");
    expect(appliedConfig.compact.base_url).toBe("http://127.0.0.1:56002/v1");
    expect(appliedConfig.compact.model_override).toBe("profile-api-compact-model");
    expect(appliedConfig.claude.compact.base_url).toBe("https://api.anthropic.com");
    expect(JSON.stringify(appliedConfig)).not.toContain("profile-api-primary-key");

    const claudeSaveResponse = await fetch(`${app.url}/api/config/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "claude",
        name: "Claude Profile API",
        config: {
          claude: {
            primary: { base_url: "http://127.0.0.1:56013" },
            compact: { base_url: "http://127.0.0.1:56014", upstream_mode: "split" }
          }
        }
      })
    });
    const claudeSavedConfig = (await claudeSaveResponse.json()) as PublicConfig;
    const claudeProfileId = claudeSavedConfig.profile_scopes.claude.profiles[0].id;
    expect(claudeSavedConfig.profile_scopes.claude.profiles[0]).toMatchObject({
      scope: "claude",
      primary_host: null,
      compact_host: null,
      claude_primary_host: "127.0.0.1:56013",
      claude_compact_host: "127.0.0.1:56014",
      compact_upstream_mode: null,
      claude_compact_upstream_mode: "split"
    });

    const claudeApplyResponse = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "claude", profile_id: claudeProfileId })
    });
    const claudeAppliedConfig = (await claudeApplyResponse.json()) as PublicConfig;

    expect(claudeApplyResponse.status).toBe(200);
    expect(claudeAppliedConfig.primary.base_url).toBe("http://127.0.0.1:56001/v1");
    expect(claudeAppliedConfig.claude.primary.base_url).toBe("http://127.0.0.1:56013");
    expect(claudeAppliedConfig.claude.compact.base_url).toBe("http://127.0.0.1:56014");
    expect(claudeAppliedConfig.profile_scopes.codex.active_profile_id).toBe(profileId);
    expect(claudeAppliedConfig.profile_scopes.claude.active_profile_id).toBe(claudeProfileId);

    const previewResponse = await fetch(`${app.url}/api/test-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/v1/responses/compact",
        body: { model: "gpt-5.5" }
      })
    });
    const preview = await previewResponse.json();

    expect(preview.target_model).toBe("profile-api-compact-model");
    expect(preview.upstream_host).toBe("127.0.0.1:56002");

    const patchResponse = await fetch(`${app.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        primary: {
          base_url: "http://127.0.0.1:56005/v1"
        }
      })
    });
    const patchedConfig = (await patchResponse.json()) as PublicConfig;

    expect(patchResponse.status).toBe(200);
    expect(patchedConfig.active_profile_id).toBeNull();
    expect(patchedConfig.profiles).toHaveLength(1);
    expect(JSON.stringify(patchedConfig)).not.toContain("profile-api-primary-key");

    const updateResponse = await fetch(`${app.url}/api/config/profiles`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile_id: profileId,
        name: "Profile API Updated",
        config: {
          compact: {
            model_override: "profile-api-updated-model"
          }
        }
      })
    });
    const updatedConfig = (await updateResponse.json()) as PublicConfig;

    expect(updateResponse.status).toBe(200);
    expect(updatedConfig.profiles).toHaveLength(1);
    expect(updatedConfig.profiles[0]).toMatchObject({
      id: profileId,
      name: "Profile API Updated"
    });
    expect(JSON.stringify(updatedConfig)).not.toContain("profile-api-primary-key");

    const duplicateResponse = await fetch(`${app.url}/api/config/profiles/duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile_id: profileId,
        name: "Profile API Copy"
      })
    });
    const duplicatedConfig = (await duplicateResponse.json()) as PublicConfig;
    const copiedProfile = duplicatedConfig.profiles.find((profile) => profile.name === "Profile API Copy");

    expect(duplicateResponse.status).toBe(200);
    expect(duplicatedConfig.profiles).toHaveLength(2);
    expect(copiedProfile?.id).toBeTruthy();
    expect(copiedProfile?.id).not.toBe(profileId);
    expect(JSON.stringify(duplicatedConfig)).not.toContain("profile-api-primary-key");

    const deleteResponse = await fetch(`${app.url}/api/config/profiles`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile_id: profileId
      })
    });
    const deletedConfig = (await deleteResponse.json()) as PublicConfig;

    expect(deleteResponse.status).toBe(200);
    expect(deletedConfig.profiles).toHaveLength(1);
    expect(deletedConfig.profiles[0].id).toBe(copiedProfile?.id);
    expect(deletedConfig.active_profile_id).toBeNull();
    expect(JSON.stringify(deletedConfig)).not.toContain("profile-api-primary-key");
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
      model: "gpt-5.5-openai-compact",
      stream: true
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

  it("proxies Claude requests, records Anthropic usage, and redacts captured credentials", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);

    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startClaudeUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 42,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 4,
              output_tokens: 1
            }
          }
        })}\n\n`
      );
      res.end(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 7 }
        })}\n\n`
      );
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages?beta=true`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        stream: true,
        messages: [{ role: "user", content: "capture claude" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer client-token"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("claude");
    expect(await response.text()).toContain("message_start");
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/messages?beta=true");
    expect(captured.current.headers.authorization).toBe("Bearer saved-claude-token");
    expect(captured.current.headers["x-api-key"]).toBe("saved-claude-token");
    expect(captured.current.headers["anthropic-api-key"]).toBe("saved-claude-token");
    expect(captured.current.body).toContain("capture claude");

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "claude",
      endpoint: "/messages",
      request_type: "stream",
      source_model: "claude-opus-4-8",
      target_model: "claude-opus-4-8",
      input_tokens: 42,
      output_tokens: 7,
      cached_input_tokens: 34,
      total_tokens: 49
    });

    const captures = await waitForCaptureRecords(captureDir, 1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      route: "claude",
      source_model: "claude-opus-4-8",
      target_model: "claude-opus-4-8"
    });
    expect(captures[0].upstream_request.headers.authorization).toBe("[redacted]");
    expect(captures[0].upstream_request.headers["x-api-key"]).toBe("[redacted]");
    expect(captures[0].upstream_request.headers["anthropic-api-key"]).toBe("[redacted]");
    expect(captures[0].incoming_request.headers.authorization).toBe("[redacted]");
    expect(JSON.stringify(captures[0])).not.toContain("saved-claude-token");
    expect(JSON.stringify(captures[0])).not.toContain("client-token");
  });

  it("keeps Claude Code manual compact summaries on the Claude primary route", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", usage: { input_tokens: 2, output_tokens: 3 } }));
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", usage: { input_tokens: 5, output_tokens: 7 } }));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const manualCompactPrompt = [
      "Your task is to create a detailed summary of the conversation so far.",
      "CRITICAL: Respond with TEXT ONLY.",
      "<summary>",
      "Include the full context needed to continue.",
      "</summary>"
    ].join("\n");
    const compactResponse = await fetch(`${app.url}/anthropic/v1/messages?beta=true`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: manualCompactPrompt }]
          }
        ]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });
    expect(compactResponse.status).toBe(200);
    expect(compactResponse.headers.get("x-compactgate-route")).toBe("claude");
    expect(compactResponse.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(compactResponse.headers.get("x-compactgate-claude-retry")).toBeNull();
    await compactResponse.text();

    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[0].url).toBe("/v1/messages?beta=true");
    expect(primaryRequests[0].headers["anthropic-api-key"]).toBe("saved-claude-primary-token");
    expect(primaryRequests[0].body).toContain("Your task is to create a detailed summary");

    const page = await fetchLogPage(app.url);
    expect(page.logs[0]).toMatchObject({
      route: "claude",
      status: 200,
      upstream_host: new URL(claudePrimary.url).host
    });
  });

  it("does not auto-compact Claude primary failures before the reconnect threshold", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });

      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "overloaded_error", message: "primary route overloaded" }
        })
      );
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "SUMMARY FROM CLAUDE COMPACT" }],
          usage: { input_tokens: 17, output_tokens: 19 }
        })
      );
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages?beta=true`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        metadata: { reconnect_count: 4 },
        messages: [{ role: "user", content: "original context that primary cannot handle" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("x-compactgate-route")).toBe("claude");
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(response.headers.get("x-compactgate-claude-retry")).toBeNull();
    expect(await response.text()).toContain("primary route overloaded");

    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[0].headers["anthropic-api-key"]).toBe("saved-claude-primary-token");
    expect(primaryRequests[0].body).toContain("original context that primary cannot handle");

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "claude",
      status: 503,
      upstream_host: new URL(claudePrimary.url).host
    });
  });

  it("does not auto-compact Claude requests with non-exact reconnect count fields", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "PRIMARY" }] }));
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "SUMMARY" }] }));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        metadata: { reconnect: { count: 5 } },
        messages: [{ role: "user", content: "do not auto compact" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-retry")).toBeNull();
    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(0);
  });

  it("does not auto-compact oversized normal Claude requests", async () => {
    setEnv("COMPACTGATE_CLAUDE_AUTO_COMPACT_BYTES", "256");

    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          content: [
            {
              type: "text",
              text: "UNCOMPACTED_PRIMARY_OK"
            }
          ],
          usage: { input_tokens: 3, output_tokens: 29 }
        })
      );
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip"
      });
      res.end(
        gzipSync(JSON.stringify({
          type: "message",
          content: [{ type: "thinking", thinking: "SIZE SUMMARY FROM CLAUDE COMPACT" }],
          usage: { input_tokens: 31, output_tokens: 37 }
        }))
      );
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "large context ".repeat(80) }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(response.headers.get("x-compactgate-claude-retry")).toBeNull();
    expect(body).toContain("UNCOMPACTED_PRIMARY_OK");

    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[0].body).toContain("large context");
  });

  it("auto-compacts Claude reconnect requests at count 5 and reuses persisted summaries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      const body = await captureBody(req);
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          content: [
            {
              type: "text",
              text: body.includes("PERSISTED SUMMARY FROM CLAUDE COMPACT")
                ? `RETRIED_WITH_SUMMARY_${primaryRequests.length}`
                : "UNCOMPACTED_SHOULD_NOT_RETURN"
            }
          ],
          usage: { input_tokens: 41, output_tokens: 43 }
        })
      );
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "PERSISTED SUMMARY FROM CLAUDE COMPACT" }],
          usage: { input_tokens: 47, output_tokens: 53 }
        })
      );
    });
    const configPatch = {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    };
    const requestBody = JSON.stringify({
      model: "claude-opus-4-8",
      metadata: { reconnect_count: 5 },
      messages: [{ role: "user", content: "persisted large context ".repeat(80) }]
    });
    const headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    };

    const firstApp = await startAppInDir(dir, undefined, undefined, configPatch);
    const firstResponse = await fetch(`${firstApp.url}/anthropic/v1/messages`, {
      method: "POST",
      body: requestBody,
      headers
    });
    const firstBody = await firstResponse.text();

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("x-compactgate-claude-retry")).toBe("compacted");
    expect(firstResponse.headers.get("x-compactgate-claude-retry-reason")).toBe("reconnect");
    expect(firstResponse.headers.get("x-compactgate-claude-summary")).toBe("generated");
    expect(firstBody).toContain("RETRIED_WITH_SUMMARY_1");
    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(1);
    expect(compactRequests[0].body).toContain("persisted large context");
    expect(primaryRequests[0].body).toContain("PERSISTED SUMMARY FROM CLAUDE COMPACT");
    expect(primaryRequests[0].body).not.toContain("persisted large context");

    await firstApp.close();

    const restartedApp = await startAppInDir(dir, undefined, undefined, configPatch);
    const secondResponse = await fetch(`${restartedApp.url}/anthropic/v1/messages`, {
      method: "POST",
      body: requestBody,
      headers
    });
    const secondBody = await secondResponse.text();

    expect(secondResponse.status).toBe(200);
    expect(secondResponse.headers.get("x-compactgate-claude-retry")).toBe("compacted");
    expect(secondResponse.headers.get("x-compactgate-claude-retry-reason")).toBe("reconnect");
    expect(secondResponse.headers.get("x-compactgate-claude-summary")).toBe("cached");
    expect(secondBody).toContain("RETRIED_WITH_SUMMARY_2");
    expect(primaryRequests).toHaveLength(2);
    expect(compactRequests).toHaveLength(1);
    expect(primaryRequests[1].body).toContain("PERSISTED SUMMARY FROM CLAUDE COMPACT");
    expect(primaryRequests[1].body).not.toContain("persisted large context");
  });

  it("reuses a cached Claude prefix summary and preserves new tail messages", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      const body = await captureBody(req);
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "PRIMARY" }] }));
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "PREFIX SUMMARY" }]
        })
      );
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });
    const headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    };

    const firstResponse = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        metadata: { reconnect_count: 5 },
        messages: [{ role: "user", content: "shared prefix context" }]
      }),
      headers
    });
    await firstResponse.text();

    const secondResponse = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        metadata: { reconnect_count: 5 },
        messages: [
          { role: "user", content: "shared prefix context" },
          { role: "user", content: "new tail message" }
        ]
      }),
      headers
    });
    await secondResponse.text();

    expect(firstResponse.headers.get("x-compactgate-claude-summary")).toBe("generated");
    expect(secondResponse.headers.get("x-compactgate-claude-summary")).toBe("cached");
    expect(compactRequests).toHaveLength(1);
    expect(primaryRequests).toHaveLength(2);
    expect(primaryRequests[1].body).toContain("PREFIX SUMMARY");
    expect(primaryRequests[1].body).toContain("new tail message");
    expect(primaryRequests[1].body).not.toContain("shared prefix context");
  });

  it("uses the configured Claude compact summary model without rewriting the primary retry model", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "PRIMARY_AFTER_SUMMARY" }] }));
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "SUMMARY USING COMPACT MODEL" }]
        })
      );
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split",
          model_override: "claude-summary-model"
        }
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-original-model",
        metadata: { reconnect_count: 5 },
        messages: [{ role: "user", content: "context for compact model override" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-summary")).toBe("generated");
    expect(compactRequests).toHaveLength(1);
    expect(primaryRequests).toHaveLength(1);
    expect(JSON.parse(compactRequests[0].body).model).toBe("claude-summary-model");
    expect(JSON.parse(primaryRequests[0].body).model).toBe("claude-original-model");
    expect(primaryRequests[0].body).toContain("SUMMARY USING COMPACT MODEL");
  });

  it("can reuse the Claude primary upstream for compact summary generation", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      const body = await captureBody(req);
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body
      });
      res.writeHead(200, { "content-type": "application/json" });
      if (body.includes("Your task is to create a detailed summary")) {
        res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "PRIMARY ROUTE SUMMARY" }] }));
        return;
      }

      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "PRIMARY RETRY" }] }));
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "COMPACT" }] }));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "primary"
        }
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-original-model",
        metadata: { reconnect_count: 5 },
        messages: [{ role: "user", content: "context for primary-mode compact" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-summary")).toBe("generated");
    expect(primaryRequests).toHaveLength(2);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[0].headers["anthropic-api-key"]).toBe("saved-claude-primary-token");
    expect(primaryRequests[0].body).toContain("Your task is to create a detailed summary");
    expect(primaryRequests[1].body).toContain("PRIMARY ROUTE SUMMARY");
  });

  it("does not route Claude manual compact prompts to the compact route", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startClaudeUpstream(async (req, res) => {
      primaryRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "PRIMARY" }] }));
    });
    const claudeCompact = await startClaudeUpstream(async (req, res) => {
      compactRequests.push({
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      });
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "bad_gateway", message: "compact failed" } }));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token"
        }
      }
    });

    const manualCompactPrompt = [
      "Your task is to create a detailed summary of the conversation so far.",
      "CRITICAL: Respond with TEXT ONLY.",
      "<summary>",
      "Summarize the previous context.",
      "</summary>"
    ].join("\n");
    const response = await fetch(`${app.url}/anthropic/v1/messages?beta=true`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: [{ type: "text", text: manualCompactPrompt }] }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(response.headers.get("x-compactgate-claude-retry")).toBeNull();
    expect(await response.text()).toContain("PRIMARY");
    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[0].headers["anthropic-api-key"]).toBe("saved-claude-primary-token");
    expect(primaryRequests[0].body).toContain("Your task is to create a detailed summary");
  });

  it("uses an HTTP CONNECT proxy for HTTPS Claude upstream requests", async () => {
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    setEnv("HTTPS_PROXY", "");
    setEnv("https_proxy", "");
    setEnv("HTTP_PROXY", "");
    setEnv("http_proxy", "");
    setEnv("NO_PROXY", "");
    setEnv("no_proxy", "");

    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startHttpsClaudeUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          usage: { input_tokens: 3, output_tokens: 5 },
          content: [{ type: "text", text: "CONNECT_PROXY_OK" }]
        })
      );
    });
    const proxy = await startConnectProxy();
    setEnv("HTTPS_PROXY", proxy.url);

    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "use connect proxy" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("CONNECT_PROXY_OK");
    expect(proxy.connectTargets).toContain(new URL(claude.url).host);
    assertCaptured(captured.current);
    expect(captured.current.headers["anthropic-api-key"]).toBe("saved-claude-token");
    expect(captured.current.body).toContain("use connect proxy");
  });

  it("logs and captures Claude requests when the client disconnects before upstream completes", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);

    let markUpstreamReceived: () => void = () => {};
    const upstreamReceived = new Promise<void>((resolve) => {
      markUpstreamReceived = resolve;
    });
    const claude = await startClaudeUpstream(async (req, res) => {
      await captureBody(req);
      markUpstreamReceived();
      res.writeHead(200, { "content-type": "text/event-stream" });
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const request = http.request(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" }
    });
    const requestClosed = new Promise<void>((resolve) => {
      request.once("close", resolve);
    });
    request.on("error", () => undefined);

    request.end(
      JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "disconnect claude" }]
      })
    );
    await upstreamReceived;
    request.destroy();
    await requestClosed;

    const entry = await waitForLogEntry(app.url, (candidate) => candidate.route === "claude");
    expect(entry).toMatchObject({
      route: "claude",
      status: 502,
      endpoint: "/messages",
      source_model: "claude-opus-4-8",
      target_model: "claude-opus-4-8",
      error_summary: "Client disconnected before upstream response completed."
    });

    const captures = await waitForCaptureRecords(captureDir, 1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      route: "claude",
      source_model: "claude-opus-4-8",
      target_model: "claude-opus-4-8"
    });
    expect(captures[0].upstream_response.status).toBe(502);
    expect(JSON.stringify(captures[0])).not.toContain("saved-claude-token");
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

  it("persists all SQLite logs across restarts and pages the visible list", async () => {
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
    const firstPage = await fetchLogPage(firstApp.url);
    expect(firstPage.total).toBe(3);
    expect(firstPage.all_total).toBe(3);
    expect(firstPage.provider_counts).toEqual({
      all: 3,
      openai: 3,
      claude: 0
    });
    expect(firstPage.has_more).toBe(true);

    await firstApp.close();

    const restartedApp = await startAppInDir(dir, primary.url, compact.url, {
      logging: { keep_recent: 2 }
    });
    const restartedLogs = await fetchRecentLogs(restartedApp.url);

    expect(restartedLogs).toHaveLength(2);
    expect(restartedLogs.map((entry) => entry.source_model)).toEqual(["gpt-5.5", "gpt-5.4"]);
    const olderPage = await fetchLogPage(restartedApp.url, "?limit=2&offset=2");
    expect(olderPage.logs).toHaveLength(1);
    expect(olderPage.logs[0].source_model).toBe("gpt-5.3");
    expect(olderPage.total).toBe(3);
    expect(olderPage.has_more).toBe(false);
    expect(JSON.stringify(restartedLogs)).not.toContain("sensitive prompt");
  });

  it("ignores COMPACTGATE_LOG_DB and always writes the config-derived log database", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const overrideDbPath = path.join(dir, "runtime", "override-logs.sqlite");
    process.env.COMPACTGATE_LOG_DB = overrideDbPath;
    cleanupEnvKeys.add("COMPACTGATE_LOG_DB");

    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const app = await startAppInDir(dir, primary.url, compact.url);

    await sendCompactRequest(app.url, "gpt-5.6");

    const page = await fetchLogPage(app.url);
    expect(page.provider_counts).toEqual({
      all: 1,
      openai: 1,
      claude: 0
    });
    expect(page.logs[0].source_model).toBe("gpt-5.6");
    expect("storage" in page).toBe(false);

    const defaultDbCount = readLogCount(path.join(dir, "compactgate-logs.sqlite"));
    expect(defaultDbCount).toBe(1);
    expect(() => readLogCount(overrideDbPath)).toThrow();
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
      cached_output_tokens: null,
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

async function startClaudeUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(handler);
  await listen(server);
  trackServer(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`
  };
}

async function startHttpsClaudeUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void
) {
  const server = https.createServer(
    {
      cert: LOCALHOST_CERT,
      key: LOCALHOST_KEY
    },
    handler
  );
  await listen(server);
  trackServer(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    url: `https://127.0.0.1:${address.port}`
  };
}

async function startConnectProxy() {
  const connectTargets: string[] = [];
  const sockets = new Set<Duplex | net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end("CONNECT only");
  });

  server.on("connect", (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.once("close", () => sockets.delete(clientSocket));

    const target = req.url ?? "";
    connectTargets.push(target);
    const [host, rawPort] = target.split(":");
    const port = Number(rawPort);
    if (!host || !Number.isInteger(port)) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    const upstreamSocket = net.connect(port, host, () => {
      sockets.add(upstreamSocket);
      upstreamSocket.once("close", () => sockets.delete(upstreamSocket));
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.once("error", () => {
      clientSocket.destroy();
    });
    clientSocket.once("error", () => {
      upstreamSocket.destroy();
    });
  });

  await listen(server);
  cleanup.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await close(server);
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    connectTargets,
    url: `http://127.0.0.1:${address.port}`
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
  return (await fetchLogPage(baseUrl)).logs;
}

async function waitForLogEntry(
  baseUrl: string,
  predicate: (entry: RequestLogEntry) => boolean
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const match = (await fetchRecentLogs(baseUrl)).find(predicate);
    if (match) {
      return match;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const logs = await fetchRecentLogs(baseUrl);
  const match = logs.find(predicate);
  if (!match) {
    throw new Error("Expected log entry was not recorded.");
  }

  return match;
}

async function fetchLogPage(baseUrl: string, query = "") {
  const response = await fetch(`${baseUrl}/api/logs/recent${query}`);
  const body = await response.json();
  return body as RequestLogPage;
}

function readLogCount(databasePath: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM request_logs").get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
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
