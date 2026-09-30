import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { requestJson } from "../src/server/upstream-json-client.js";
import { sendBufferedUpstreamRequest, sendOpenAiUpstreamRequest, UpstreamRequestError } from "../src/server/upstream-client.js";
import { listen, trackServer } from "./helpers/server-test-lifecycle.js";

describe("upstream connection lifecycle", () => {
  it.each(["json", "buffered", "sse"])("enforces a total budget despite continuous %s bytes", async (mode) => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": mode === "sse" ? "text/event-stream" : "application/json" });
      const timer = setInterval(() => res.write(mode === "sse" ? ": heartbeat\n\n" : " "), 15);
      res.once("close", () => clearInterval(timer));
    });
    await listen(upstream);
    trackServer(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");
    const target = new URL(`http://127.0.0.1:${address.port}`);
    if (mode === "json") {
      await expect(requestJson(target, {}, 80)).rejects.toThrow("timed out");
      return;
    }
    let failure: unknown;
    const app = http.createServer(async (req, res) => {
      try {
        await sendOpenAiUpstreamRequest({ req, res, upstream: target, startedAt: performance.now(), timeoutMs: 80,
          timeoutMessage: "total deadline", requestHeaders: {}, body: Buffer.alloc(0), extraResponseHeaders: {}, writeResponse: false });
        res.end("unexpected success");
      } catch (error) { failure = error; res.writeHead(504); res.end("timeout"); }
    });
    await listen(app);
    trackServer(app);
    const local = app.address();
    if (!local || typeof local === "string") throw new Error("Missing app port");
    const response = await fetch(`http://127.0.0.1:${local.port}`);
    expect(response.status).toBe(504);
    await response.text();
    expect(failure).toBeInstanceOf(UpstreamRequestError);
    expect((failure as UpstreamRequestError).details.kind).toBe("timeout");
  });

  it("does not authorize network I/O after preparation exhausted the budget", async () => {
    let calls = 0;
    const upstream = http.createServer((_req, res) => { calls++; res.end("{}"); });
    await listen(upstream);
    trackServer(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");
    const app = http.createServer(async (req, res) => {
      try {
        await sendOpenAiUpstreamRequest({ req, res, upstream: new URL(`http://127.0.0.1:${address.port}`),
          startedAt: performance.now() - 500, timeoutMs: 80, timeoutMessage: "total deadline",
          requestHeaders: {}, body: Buffer.alloc(0), extraResponseHeaders: {}, retryHttpStatuses: [503], maxHttpStatusRetries: 3 });
        res.end("unexpected");
      } catch { res.writeHead(504); res.end(); }
    });
    await listen(app);
    trackServer(app);
    const local = app.address();
    if (!local || typeof local === "string") throw new Error("Missing app port");
    const response = await fetch(`http://127.0.0.1:${local.port}`);
    expect(response.status).toBe(504);
    await response.text();
    expect(calls).toBe(0);
  });
  it.each(["CONNECT", "TLS"])("bounds a stalled %s handshake and closes its socket", async (phase) => {
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.once("data", () => {
        if (phase === "TLS") socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
      socket.resume();
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    try {
      await expect(requestJson(new URL("https://example.test/"), {}, 80, {
        proxyUrl: `http://127.0.0.1:${address.port}`
      })).rejects.toThrow(/timed out/);
      await expect.poll(() => sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("client cancellation closes a pending CONNECT without destroying the shared agent", async () => {
    let connected!: () => void;
    const connection = new Promise<void>((resolve) => { connected = resolve; });
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.resume();
      connected();
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    let failure: unknown;
    const app = http.createServer(async (req, res) => {
      try {
        await sendBufferedUpstreamRequest({ req, res, upstream: new URL("https://example.test/"),
          proxyUrl: `http://127.0.0.1:${address.port}`, startedAt: performance.now(), timeoutMs: 5_000,
          timeoutMessage: "deadline", requestHeaders: {}, body: Buffer.alloc(0), extraResponseHeaders: {} });
      } catch (error) { failure = error; res.destroy(); }
    });
    await listen(app);
    trackServer(app);
    const local = app.address();
    if (!local || typeof local === "string") throw new Error("Missing app port");
    const abort = new AbortController();
    const result = fetch(`http://127.0.0.1:${local.port}`, { signal: abort.signal }).catch(() => undefined);
    try {
      await connection;
      abort.abort();
      await result;
      await expect.poll(() => sockets.size).toBe(0);
      expect(failure).toBeInstanceOf(UpstreamRequestError);
      expect((failure as UpstreamRequestError).details.kind).toBe("client_cancel");
    } finally {
      abort.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
