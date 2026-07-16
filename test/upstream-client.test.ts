import http from "node:http";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import "./helpers/server-test-hooks.js";
import {
  requestJson,
  sendOpenAiUpstreamRequest,
  sendBufferedUpstreamRequest,
  type BufferedUpstreamResult
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

describe("requestJson", () => {
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
