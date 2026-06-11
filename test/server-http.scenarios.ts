import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StudioEventBroadcaster } from "../src/server/studio-events.js";
import type { HealthResponse, PublicConfig, RequestLogEntry } from "../src/shared/types.js";
import {
  captureBody,
  cleanup,
  fetchRecentLogs,
  openSseStream,
  startApp,
  startAppInDir,
  startUpstream
} from "./helpers/server-test-utils.js";

describe("CompactGate HTTP basics", () => {
  it("returns health status", async () => {
    const app = await startApp();

    const response = await fetch(`${app.url}/api/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("serves static assets without falling back missing files to the SPA index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-static-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "dist/public/assets"), { recursive: true });
    await writeFile(
      path.join(dir, "dist/public/index.html"),
      '<!doctype html><script type="module" src="/assets/app.js"></script><div id="root"></div>'
    );
    await writeFile(path.join(dir, "dist/public/assets/app.js"), "console.log('ok');");

    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const app = await startAppInDir(dir);

      const indexResponse = await fetch(`${app.url}/`);
      expect(indexResponse.status).toBe(200);
      expect(indexResponse.headers.get("cache-control")).toBe("no-cache");
      expect(await indexResponse.text()).toContain("/assets/app.js");

      const assetResponse = await fetch(`${app.url}/assets/app.js`);
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable"
      );
      expect(await assetResponse.text()).toBe("console.log('ok');");

      const missingAssetResponse = await fetch(`${app.url}/assets/missing.js`);
      expect(missingAssetResponse.status).toBe(404);
      expect(await missingAssetResponse.json()).toEqual({ error: "File not found." });

      const missingExtensionlessAssetResponse = await fetch(`${app.url}/assets/missing`);
      expect(missingExtensionlessAssetResponse.status).toBe(404);
      expect(await missingExtensionlessAssetResponse.json()).toEqual({ error: "File not found." });

      const routeResponse = await fetch(`${app.url}/config/profiles`);
      expect(routeResponse.status).toBe(200);
      expect(routeResponse.headers.get("cache-control")).toBe("no-cache");
      expect(await routeResponse.text()).toContain("/assets/app.js");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("returns a controlled client error for malformed static URL encoding", async () => {
    const app = await startApp();

    const response = await fetch(`${app.url}/%E0%A4%A`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Malformed URL path." });
  });

  it("returns a controlled client error for malformed absolute request targets", async () => {
    const app = await startApp();

    const result = await sendRawHttpRequest(app.url, [
      "GET http://% HTTP/1.1",
      "Host: compactgate.local",
      "Connection: close",
      "",
      ""
    ].join("\r\n"));

    expect(result).toMatchObject({ status: 400 });
    if ("status" in result) {
      expect(JSON.parse(result.text)).toEqual({ error: "Malformed request URL." });
    }
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
      status: 200,
      incoming_request_body: null,
      upstream_request_body: null,
      upstream_response_body: null
    });
    expect(JSON.stringify(logEvent)).not.toContain("stream me");

    await sse.close();
  });

  it("rejects SSE subscriptions above the configured admission limit", () => {
    const broadcaster = new StudioEventBroadcaster({ maxClients: 1 });
    const snapshot = {
      config: { listen: "127.0.0.1:0" },
      health: { status: "ok" },
      logs: [],
      log_page: { logs: [], limit: 1, offset: 0, total: 0, all_total: 0, has_more: false }
    };
    const firstReq = new FakeRequest();
    const firstRes = new FakeResponse();
    const secondReq = new FakeRequest();
    const secondRes = new FakeResponse();

    broadcaster.subscribe(
      firstReq as unknown as IncomingMessage,
      firstRes as unknown as ServerResponse,
      snapshot as never
    );
    broadcaster.subscribe(
      secondReq as unknown as IncomingMessage,
      secondRes as unknown as ServerResponse,
      snapshot as never
    );

    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.body).toContain("event: snapshot");
    expect(firstRes.writableEnded).toBe(false);
    expect(secondRes.statusCode).toBe(429);
    expect(secondRes.body).toContain("Too many live event clients.");
    expect(secondRes.writableEnded).toBe(true);

    broadcaster.close();
    expect(firstRes.writableEnded).toBe(true);
  });

  it("keeps SSE clients when event writes report backpressure", () => {
    const broadcaster = new StudioEventBroadcaster({ maxClients: 1 });
    const snapshot = {
      config: { listen: "127.0.0.1:0" },
      health: { status: "ok" },
      logs: [],
      log_page: { logs: [], limit: 1, offset: 0, total: 0, all_total: 0, has_more: false }
    };
    const req = new FakeRequest();
    const res = new FakeResponse({ backpressureAfter: 2 });

    broadcaster.subscribe(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      snapshot as never
    );

    expect(res.statusCode).toBe(200);
    expect(res.writableEnded).toBe(false);
    expect(res.body).toContain("event: snapshot");
    const writesAfterSubscribe = res.writeCount;

    broadcaster.broadcastLog({
      time: new Date().toISOString(),
      route: "primary",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/responses",
      request_type: "http",
      reasoning_effort: null,
      request_summary: null,
      incoming_request_body: "large incoming body",
      upstream_request_body: "large upstream body",
      upstream_response_body: "large response body",
      source_model: "gpt-5.5",
      target_model: "gpt-5.5",
      status: 200,
      duration_ms: 1,
      first_token_ms: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      cached_output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      reasoning_tokens: null,
      additive_cached_input_tokens: false,
      additive_cached_output_tokens: false,
      total_tokens: null,
      upstream_host: "upstream.test",
      user_agent: null,
      request_id: "req-1",
      error_summary: null
    });

    expect(res.writeCount).toBeGreaterThan(writesAfterSubscribe);
    expect(res.body).toContain("event: log");
    expect(res.body).not.toContain("large incoming body");
    expect(res.body).not.toContain("large upstream body");
    expect(res.body).not.toContain("large response body");
    broadcaster.close();
    expect(res.writableEnded).toBe(true);
  });

  it("drops SSE clients when event writes throw", () => {
    const broadcaster = new StudioEventBroadcaster({ maxClients: 1 });
    const snapshot = {
      config: { listen: "127.0.0.1:0" },
      health: { status: "ok" },
      logs: [],
      log_page: { logs: [], limit: 1, offset: 0, total: 0, all_total: 0, has_more: false }
    };
    const req = new FakeRequest();
    const res = new FakeResponse({ throwWritesAfter: 2 });

    broadcaster.subscribe(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      snapshot as never
    );

    expect(res.statusCode).toBe(200);
    expect(res.writableEnded).toBe(true);
    expect(res.body).toContain("event: snapshot");

    broadcaster.broadcastLog({
      time: new Date().toISOString(),
      route: "primary",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/responses",
      request_type: "http",
      reasoning_effort: null,
      request_summary: null,
      incoming_request_body: null,
      upstream_request_body: null,
      upstream_response_body: null,
      source_model: "gpt-5.5",
      target_model: "gpt-5.5",
      status: 200,
      duration_ms: 1,
      first_token_ms: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      cached_output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      reasoning_tokens: null,
      additive_cached_input_tokens: false,
      additive_cached_output_tokens: false,
      total_tokens: null,
      upstream_host: "upstream.test",
      user_agent: null,
      request_id: "req-1",
      error_summary: null
    });

    expect(res.writeCount).toBe(2);
    broadcaster.close();
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

  it("returns a controlled error for oversized OpenAI request bodies", async () => {
    const app = await startApp();
    const body = Buffer.concat([
      Buffer.from('{"model":"gpt-5.5","input":"'),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
      Buffer.from('"}')
    ]);

    const result = await postRawBody(`${app.url}/v1/responses`, body);

    expect(result).toMatchObject({ status: 413 });
    if ("text" in result) {
      expect(JSON.parse(result.text)).toMatchObject({ error: "Request body is too large." });
    }
  });

  it("settles OpenAI request body reads when the client disconnects mid-upload", async () => {
    const primary = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    await postPartialBodyAndAbort(
      `${app.url}/v1/responses`,
      Buffer.from('{"model":"gpt-5.5","input":"partial')
    );

    const log = await waitForLatestLog(app.url, (entry) =>
      entry.route === "primary" &&
      entry.status === 502 &&
      entry.error_summary === "Client disconnected before request body completed."
    );

    expect(log).toMatchObject({
      route: "primary",
      endpoint: "/responses",
      status: 502,
      error_summary: "Client disconnected before request body completed."
    });
  });
});

function postRawBody(
  targetUrl: string,
  body: Buffer
): Promise<{ status: number | undefined; text: string } | { error: string }> {
  const target = new URL(targetUrl);
  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      resolve({ error: error.code ?? error.message });
    });
    request.end(body);
  });
}

function sendRawHttpRequest(
  targetUrl: string,
  requestText: string
): Promise<{ status: number; text: string } | { error: string; text?: string }> {
  const target = new URL(targetUrl);
  return new Promise((resolve) => {
    let settled = false;
    let responseText = "";
    const socket = net.connect(Number(target.port), target.hostname);

    const settle = (result: { status: number; text: string } | { error: string; text?: string }) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(750, () => {
      settle({ error: "timeout", text: responseText });
    });
    socket.on("connect", () => {
      socket.write(requestText);
    });
    socket.on("data", (chunk: Buffer) => {
      responseText += chunk.toString("utf8");
    });
    socket.on("end", () => {
      settle(parseRawHttpResponse(responseText));
    });
    socket.on("close", () => {
      settle(responseText ? parseRawHttpResponse(responseText) : { error: "closed" });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      settle({ error: error.code ?? error.message, text: responseText });
    });
  });
}

function parseRawHttpResponse(text: string): { status: number; text: string } | { error: string; text: string } {
  const match = /^HTTP\/1\.\d\s+(\d+)/.exec(text);
  if (!match) {
    return { error: "invalid-response", text };
  }

  return {
    status: Number(match[1]),
    text: text.split("\r\n\r\n").slice(1).join("\r\n\r\n")
  };
}

function postPartialBodyAndAbort(targetUrl: string, bodyPrefix: Buffer): Promise<void> {
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(bodyPrefix.byteLength + 4096)
        }
      }
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET" || error.code === "EPIPE") {
        resolve();
        return;
      }

      reject(error);
    });
    request.write(bodyPrefix, () => {
      request.destroy();
      resolve();
    });
  });
}

async function waitForLatestLog(
  appUrl: string,
  predicate: (entry: RequestLogEntry) => boolean
): Promise<RequestLogEntry> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const logs = await fetchRecentLogs(appUrl);
    const entry = logs.find(predicate);
    if (entry) {
      return entry;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for matching request log.");
}

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
  body = "";
  destroyed = false;
  headers: Record<string, string | number | readonly string[]> = {};
  statusCode = 0;
  writableEnded = false;
  writeCount = 0;

  constructor(private readonly options: { backpressureAfter?: number; throwWritesAfter?: number } = {}) {
    super();
  }

  writeHead(statusCode: number, headers?: Record<string, string | number | readonly string[]>): this {
    this.statusCode = statusCode;
    this.headers = headers ?? {};
    return this;
  }

  flushHeaders(): void {
    // The real ServerResponse flushes headers for SSE; fake responses only record writes.
  }

  write(chunk: string): boolean {
    this.writeCount += 1;
    if (this.options.throwWritesAfter !== undefined && this.writeCount >= this.options.throwWritesAfter) {
      throw new Error("Simulated write failure.");
    }
    this.body += chunk;
    return this.options.backpressureAfter === undefined || this.writeCount < this.options.backpressureAfter;
  }

  end(chunk?: string): this {
    if (chunk) {
      this.body += chunk;
    }
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
}
