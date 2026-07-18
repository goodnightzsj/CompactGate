import http from "node:http";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import "./helpers/server-test-hooks.js";
import {
  classifyOpenAiUpstreamResult,
  requestJson,
  sendOpenAiUpstreamRequest,
  sendBufferedUpstreamRequest,
  type BufferedUpstreamResult,
  UpstreamStatusError
} from "../src/server/upstream-client.js";
import { listen, trackServer } from "./helpers/server-test-lifecycle.js";
import { startUpstream } from "./helpers/server-test-utils.js";

describe("sendBufferedUpstreamRequest", () => {
  it("bounds the internal response buffer without truncating the client response", async () => {
    const upstreamBody = "0123456789abcdef";
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(upstreamBody);
    });
    let bufferedBody: Buffer = Buffer.alloc(0);

    const proxy = http.createServer(async (req, res) => {
      const result = await sendBufferedUpstreamRequest({
        req,
        res,
        upstream: new URL(upstream.url),
        startedAt: performance.now(),
        timeoutMs: 1_000,
        timeoutMessage: "test upstream timed out",
        requestHeaders: {},
        body: Buffer.alloc(0),
        extraResponseHeaders: {},
        maxBufferedResponseBytes: 8
      });
      bufferedBody = result.responseBody;
    });
    await listen(proxy);
    trackServer(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/test`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamBody);
    expect(bufferedBody.toString("utf8")).toBe("01234567");
  });

  it("bounds OpenAI SSE observer event retention without truncating the client stream", async () => {
    const oversizedData = "x".repeat(128);
    const completionEvent = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const upstreamBody = `data: ${oversizedData}\n\n${completionEvent}`;
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(upstreamBody);
    });
    let streamSummary: BufferedUpstreamResult["streamSummary"] = null;

    const proxy = http.createServer(async (req, res) => {
      const result = await sendBufferedUpstreamRequest({
        req,
        res,
        upstream: new URL(upstream.url),
        startedAt: performance.now(),
        timeoutMs: 1_000,
        timeoutMessage: "test upstream timed out",
        requestHeaders: {},
        body: Buffer.alloc(0),
        extraResponseHeaders: {},
        maxBufferedResponseBytes: 0,
        maxObservedStreamEventBytes: 80
      });
      streamSummary = result.streamSummary;
    });
    await listen(proxy);
    trackServer(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/test`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamBody);
    expect(streamSummary).toMatchObject({
      eventCount: 1,
      sawCompletedEvent: true,
      sawTerminalEvent: true
    });
  });

  it("observes completion events inside gzip encoded SSE responses", async () => {
    const upstreamBody = gzipSync(Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n'
    ));
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip"
      });
      res.end(upstreamBody);
    });
    let streamSummary: BufferedUpstreamResult["streamSummary"] = null;

    const proxy = http.createServer(async (req, res) => {
      const result = await sendBufferedUpstreamRequest({
        req,
        res,
        upstream: new URL(upstream.url),
        startedAt: performance.now(),
        timeoutMs: 1_000,
        timeoutMessage: "test upstream timed out",
        requestHeaders: {},
        body: Buffer.alloc(0),
        extraResponseHeaders: {}
      });
      streamSummary = result.streamSummary;
    });
    await listen(proxy);
    trackServer(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/test`);
    expect(response.status).toBe(200);
    await response.text();
    expect(streamSummary).toMatchObject({
      eventCount: 1,
      sawCompletedEvent: true,
      sawTerminalEvent: true
    });
  });

  it("classifies response.incomplete as an upstream stream failure", async () => {
    const upstreamBody = 'event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n';
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(upstreamBody);
    });
    let upstreamResult: BufferedUpstreamResult | null = null;

    const proxy = http.createServer(async (req, res) => {
      upstreamResult = await sendBufferedUpstreamRequest({
        req,
        res,
        upstream: new URL(upstream.url),
        startedAt: performance.now(),
        timeoutMs: 1_000,
        timeoutMessage: "test upstream timed out",
        requestHeaders: {},
        body: Buffer.alloc(0),
        extraResponseHeaders: {}
      });
    });
    await listen(proxy);
    trackServer(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/test`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamBody);
    const completedResult = upstreamResult as BufferedUpstreamResult | null;
    expect(completedResult).not.toBeNull();
    expect(completedResult?.streamSummary).toMatchObject({
      sawIncompleteEvent: true,
      terminalEvent: "response.incomplete"
    });
    expect(classifyOpenAiUpstreamResult(completedResult!)).toBe("upstream_stream_incomplete");
  });

  it("settles a completed SSE response when the client closes before HTTP end", async () => {
    const completionEvent = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(completionEvent);
    });
    let resolveResult!: (result: BufferedUpstreamResult) => void;
    let rejectResult!: (error: unknown) => void;
    const resultPromise = new Promise<BufferedUpstreamResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const proxy = http.createServer(async (req, res) => {
      try {
        resolveResult(await sendBufferedUpstreamRequest({
          req,
          res,
          upstream: new URL(upstream.url),
          startedAt: performance.now(),
          timeoutMs: 1_000,
          timeoutMessage: "test upstream timed out",
          requestHeaders: {},
          body: Buffer.alloc(0),
          extraResponseHeaders: {}
        }));
      } catch (error) {
        rejectResult(error);
      }
    });
    await listen(proxy);
    trackServer(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }

    const clientBody = await readUntilAndClose(
      `http://127.0.0.1:${address.port}/v1/test`,
      "response.completed"
    );
    const result = await resultPromise;

    expect(clientBody).toContain("response.completed");
    expect(result).toMatchObject({
      status: 200,
      clientDisconnectPhase: "after_terminal",
      responseBodyTruncated: false
    });
    expect(result.responseBody.toString("utf8")).toBe(completionEvent);
    expect(result.streamSummary).toMatchObject({
      sawCompletedEvent: true,
      terminalEvent: "response.completed"
    });
  });

  it("preserves response context when the client closes before an SSE terminal event", async () => {
    const partialEvent = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(partialEvent);
    });
    let rejectResult!: (error: unknown) => void;
    const resultPromise = new Promise<BufferedUpstreamResult>((_resolve, reject) => {
      rejectResult = reject;
    });

    const proxy = http.createServer(async (req, res) => {
      try {
        await sendBufferedUpstreamRequest({
          req,
          res,
          upstream: new URL(upstream.url),
          startedAt: performance.now(),
          timeoutMs: 1_000,
          timeoutMessage: "test upstream timed out",
          requestHeaders: {},
          body: Buffer.alloc(0),
          extraResponseHeaders: {}
        });
      } catch (error) {
        rejectResult(error);
      }
    });
    await listen(proxy);
    trackServer(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }

    await readUntilAndClose(`http://127.0.0.1:${address.port}/v1/test`, "partial");

    await expect(resultPromise).rejects.toMatchObject({
      message: "Client disconnected before upstream response completed.",
      details: expect.objectContaining({
        status: 200,
        clientDisconnectPhase: "before_terminal",
        kind: "client_cancel"
      })
    });
  });

  it("bounds deferred retryable 5xx response buffering before OpenAI stream retry", async () => {
    const oversizedBody = "x".repeat(64);
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(oversizedBody);
    });
    let bufferedBody: Buffer = Buffer.alloc(0);
    let responseBodyTruncated = false;

    const proxy = http.createServer(async (req, res) => {
      const result = await sendOpenAiUpstreamRequest({
        req,
        res,
        upstream: new URL(upstream.url),
        startedAt: performance.now(),
        timeoutMs: 1_000,
        timeoutMessage: "test upstream timed out",
        requestHeaders: {},
        body: Buffer.alloc(0),
        extraResponseHeaders: {},
        maxBufferedResponseBytes: 8,
        retryEmptyStreamError: true
      });
      bufferedBody = result.responseBody;
      responseBodyTruncated = result.responseBodyTruncated;
    });
    await listen(proxy);
    trackServer(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/test`);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "Upstream response exceeded the internal buffer limit before it could be forwarded."
    });
    expect(responseBodyTruncated).toBe(true);
    expect(JSON.parse(bufferedBody.toString("utf8"))).toMatchObject({
      error: "Upstream response exceeded the internal buffer limit before it could be forwarded."
    });
  });

  it("returns the deferred buffer-limit error before an oversized retryable response finishes", async () => {
    const upstreamState: { response?: http.ServerResponse } = {};
    const upstream = await startUpstream((_req, res) => {
      upstreamState.response = res;
      res.writeHead(500, { "content-type": "text/plain" });
      res.write("x".repeat(64));
    });
    let responseBodyTruncated = false;

    const proxy = http.createServer(async (req, res) => {
      const result = await sendOpenAiUpstreamRequest({
        req,
        res,
        upstream: new URL(upstream.url),
        startedAt: performance.now(),
        timeoutMs: 5_000,
        timeoutMessage: "test upstream timed out",
        requestHeaders: {},
        body: Buffer.alloc(0),
        extraResponseHeaders: {},
        maxBufferedResponseBytes: 8,
        retryEmptyStreamError: true
      });
      responseBodyTruncated = result.responseBodyTruncated;
    });
    await listen(proxy);
    trackServer(proxy);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }

    let response: Response | null = null;
    let fetchError: unknown = null;
    try {
      response = await fetch(`http://127.0.0.1:${address.port}/v1/test`, {
        signal: AbortSignal.timeout(500)
      });
    } catch (error) {
      fetchError = error;
    } finally {
      upstreamState.response?.end();
    }

    expect(fetchError).toBeNull();
    expect(response?.status).toBe(502);
    expect(await response?.json()).toMatchObject({
      error: "Upstream response exceeded the internal buffer limit before it could be forwarded."
    });
    expect(responseBodyTruncated).toBe(true);
  });
});

function readUntilAndClose(url: string, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.includes(marker)) {
          response.destroy();
          resolve(body);
        }
      });
      response.once("error", (error) => {
        if (!body.includes(marker)) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
  });
}

describe("requestJson", () => {
  it("rejects non-success HTTP responses instead of parsing redirect bodies", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(302, {
        location: "/login",
        "content-type": "text/html"
      });
      res.end("redirecting");
    });

    await expect(requestJson(new URL(upstream.url), {}, 1_000)).rejects.toEqual(
      expect.objectContaining<Partial<UpstreamStatusError>>({ status: 302 })
    );
  });

  it("rejects oversized JSON responses before buffering the whole body", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: ["oversized-model-list"] }));
    });

    await expect(
      requestJson(new URL(upstream.url), {}, 1_000, {
        maxResponseBytes: 8
      })
    ).rejects.toThrow("Upstream JSON response is too large.");
  });
});
