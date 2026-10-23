import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { resolveUpstreamAgent } from "../src/server/upstream-proxy-agent.js";
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
  it.each([
    ["openai", false, false], ["anthropic", false, false], ["openai", true, false], ["anthropic", true, false],
    ["openai", false, true], ["anthropic", false, true]
  ] as const)("reuses a %s tunnel after the client terminal (gzip=%s, translated=%s), without waiting to settle usage", async (protocol, gzip, translated) => {
    syntheticProxyEnvironment();
    const clientProtocol = translated ? (protocol === "openai" ? "anthropic" : "openai") : protocol;
    const terminal = protocol === "openai"
      ? 'data: {"type":"response.completed","response":{"id":"synthetic","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":7}}}\n\n'
      : messageStart + messageEnd;
    let posts = 0;
    let pendingResponse: ServerResponse | undefined;
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        posts += 1;
        res.setHeader("content-type", "text/event-stream");
        if (gzip) res.setHeader("content-encoding", "gzip");
        const encoded = gzip ? gzipSync(terminal) : terminal;
        if (posts === 1) { pendingResponse = res; res.write(encoded); }
        else res.end(encoded);
      });
    });
    const proxy = await startConnectProxy();
    const target = { base_url: upstream.url, api_key: "synthetic", proxy_url: proxy.url, upstream_protocol: protocol === "openai" ? "openai_responses" : "anthropic_messages" };
    const app = await startApp(undefined, undefined, clientProtocol === "openai" ? { primary: target } : { claude: { primary: target } });
    const path = clientProtocol === "openai" ? "/v1/responses" : "/anthropic/v1/messages";
    const marker = clientProtocol === "openai" ? "response.completed" : "message_stop";
    const send = () => fetch(`${app.url}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: clientProtocol === "openai" ? '{"model":"synthetic","input":[{"type":"message","role":"user","content":"hello"}],"stream":true}' : body
    });
    const response = await send();
    if (response.status !== 200) throw new Error(`Synthetic route returned ${response.status}: ${await response.text()}`);
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Missing synthetic terminal event: ${received}`);
      received += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    // Business settlement must finish while HTTP EOF is still withheld.
    await waitForLogEntry(app.url, (log) => log.client_disconnect_phase === "after_terminal");
    const first = (await fetchRecentLogs(app.url))[0];
    expect(first).toMatchObject({ input_tokens: 5, output_tokens: 7, stream_outcome: "success" });
    pendingResponse!.end(gzip ? undefined : 'data: {"usage":{"output_tokens":999}}\n\n');
    const agent = resolveUpstreamAgent(new URL(upstream.url), proxy.url)!;
    await expect.poll(() => Object.values(agent.freeSockets).flat().length).toBe(1);
    const secondBody = await (await send()).text();
    if (translated) expect(secondBody).toContain(marker);
    else expect(secondBody).toBe(terminal);
    expect(posts).toBe(2);
    expect(proxy.connectTargets).toHaveLength(1);
    const logs = await fetchRecentLogs(app.url);
    expect(logs).toHaveLength(2);
    expect(logs.find((log) => log.request_id === first.request_id)).toMatchObject({ output_tokens: 7, duration_ms: first.duration_ms });
  });

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
