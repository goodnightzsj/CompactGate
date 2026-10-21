import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  fetchRecentLogs, setEnv, startApp, startConnectProxy, startHttpsClaudeUpstream, waitForLogEntry
} from "./helpers/server-test-utils.js";

function syntheticProxyEnvironment() {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) setEnv(key, "");
  setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
}

const messageStart = 'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"synthetic","role":"assistant","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}\n\n';
const messageEnd = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const body = JSON.stringify({ model: "synthetic", messages: [{ role: "user", content: "hello" }], stream: true });

describe("pooled model requests", () => {
  it("preserves usage and SSE on sequential Claude POSTs through one tunnel", async () => {
    syntheticProxyEnvironment();
    let posts = 0;
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        posts += 1;
        res.setHeader("content-type", "text/event-stream");
        res.end(messageStart + messageEnd);
      });
    });
    const proxy = await startConnectProxy();
    const app = await startApp(undefined, undefined, {
      claude: { primary: { base_url: upstream.url, api_key: "synthetic", proxy_url: proxy.url } }
    });
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${app.url}/anthropic/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(messageStart + messageEnd);
      await nextTurn();
    }
    const logs = await fetchRecentLogs(app.url);
    expect(logs).toHaveLength(3);
    for (const log of logs) expect(log).toMatchObject({ input_tokens: 5, output_tokens: 7, stream_outcome: "success" });
    expect(posts).toBe(3);
    expect(proxy.connectTargets).toHaveLength(1);
  });

  it("does not replay a model POST after its reused connection fails", async () => {
    syntheticProxyEnvironment();
    let posts = 0;
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        posts += 1;
        if (posts === 2) { req.socket.destroy(); return; }
        res.setHeader("content-type", "application/json");
        res.end('{"id":"synthetic","type":"message","role":"assistant","model":"synthetic","content":[],"usage":{"input_tokens":5,"output_tokens":7}}');
      });
    });
    const proxy = await startConnectProxy();
    const app = await startApp(undefined, undefined, {
      claude: { primary: { base_url: upstream.url, api_key: "synthetic", proxy_url: proxy.url } }
    });
    const send = () => fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body
    });
    expect(await (await send()).json()).toHaveProperty("usage.output_tokens", 7);
    await nextTurn();
    const failed = await send();
    expect(failed.status).toBe(502);
    await failed.text();
    expect(posts).toBe(2);
    expect(proxy.connectTargets).toHaveLength(1);
    await waitForLogEntry(app.url, (log) => log.stream_outcome === "upstream_request_error");
    expect(await (await send()).json()).toHaveProperty("usage.output_tokens", 7);
    expect(posts).toBe(3);
    expect(proxy.connectTargets).toHaveLength(2);
  });

  it.each(["cancel", "timeout", "incomplete"])("releases a %s SSE without replaying it or breaking the next request", async (mode) => {
    syntheticProxyEnvironment();
    let posts = 0;
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let socketClosed: Promise<unknown> = Promise.resolve();
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        posts += 1;
        res.setHeader("content-type", "text/event-stream");
        if (posts !== 2) { res.end(messageStart + messageEnd); return; }
        socketClosed = once(req.socket, "close");
        res.write(messageStart);
        notifyStarted();
        if (mode === "incomplete") res.end();
      });
    });
    const proxy = await startConnectProxy();
    const app = await startApp(undefined, undefined, {
      claude: { primary: { base_url: upstream.url, api_key: "synthetic", proxy_url: proxy.url } },
      timeouts: { claude_ms: mode === "timeout" ? 150 : 2_000 }
    });
    const send = (signal?: AbortSignal) => fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body, signal
    });
    await (await send()).text();
    await nextTurn();
    const controller = new AbortController();
    const response = await send(controller.signal);
    await started;
    if (mode === "cancel") {
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await expect(reader.read()).rejects.toThrow();
    } else if (mode === "timeout") await expect(response.text()).rejects.toThrow();
    else await response.text();
    if (mode !== "incomplete") await socketClosed;
    const expectedOutcome = mode === "cancel" ? "client_cancel" : mode === "timeout" ? "timeout" : "upstream_stream_incomplete";
    await waitForLogEntry(app.url, (log) => log.stream_outcome === expectedOutcome);
    expect(posts).toBe(2);
    expect(await (await send()).text()).toBe(messageStart + messageEnd);
    expect(posts).toBe(3);
  });
});
