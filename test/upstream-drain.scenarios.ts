import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainUpstreamResponse, resolveUpstreamAgent, retainUpstreamProxyAgents, type DrainOutcome } from "../src/server/upstream-proxy-agent.js";
import { fetchRecentLogs, setEnv, startApp, startConnectProxy, startHttpsClaudeUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function prepareEnvironment() {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) setEnv(key, "");
  setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
}

async function closeAtTerminal(url: string, marker = "response.completed") {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: '{"model":"synthetic","input":[],"stream":true}'
  });
  const reader = response.body!.getReader();
  let received = "";
  while (!received.includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Missing synthetic terminal");
    received += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
}

describe("bounded HTTP tails after semantic completion", () => {
  it.each(["response.failed", "response.incomplete"])("does not recycle a %s response or misreport it as success", async (terminal) => {
    prepareEnvironment();
    let tail: ServerResponse | undefined;
    let calls = 0;
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        calls += 1;
        tail = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: {"type":"${terminal}","response":{"status":"${terminal.slice(9)}","error":{"message":"synthetic upstream failure"}}}\n\n`);
      });
    });
    const proxy = await startConnectProxy();
    const app = await startApp(undefined, undefined, { primary: { base_url: upstream.url, api_key: "synthetic", proxy_url: proxy.url } });
    await closeAtTerminal(`${app.url}/v1/responses`, terminal);
    await waitForLogEntry(app.url, (log) => log.client_disconnect_phase === "after_terminal");
    expect((await fetchRecentLogs(app.url))[0]).toMatchObject({ stream_outcome: "upstream_stream_incomplete", stream_terminal_event: terminal });
    await expect.poll(() => tail!.destroyed).toBe(true);
    const agent = resolveUpstreamAgent(new URL(upstream.url), proxy.url)!;
    expect(Object.values(agent.freeSockets).flat()).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it.each(["complete", "timeout", "byte_limit", "closed", "retired"] as const)("records %s transport cleanup without changing settled usage or replaying the POST", async (mode) => {
    prepareEnvironment();
    setEnv("COMPACTGATE_TRANSPORT_DIAGNOSTICS", "1");
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const records = () => output.mock.calls.flatMap(([line]) => typeof line === "string" && line.startsWith('{"type":"upstream_transport"') ? [JSON.parse(line) as Record<string, unknown>] : []);
    let tail: ServerResponse | undefined;
    let calls = 0;
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        calls += 1;
        tail = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":7}}}\n\n');
      });
    });
    const proxy = await startConnectProxy();
    const app = await startApp(undefined, undefined, { primary: { base_url: upstream.url, api_key: "synthetic", proxy_url: proxy.url } });
    await closeAtTerminal(`${app.url}/v1/responses`);
    await waitForLogEntry(app.url, (log) => log.client_disconnect_phase === "after_terminal");
    const before = (await fetchRecentLogs(app.url))[0];
    expect(before).toMatchObject({ output_tokens: 7, stream_outcome: "success" });
    expect(records()).toHaveLength(0);
    if (mode === "complete") tail!.end('data: {"usage":{"output_tokens":999}}\n\n');
    if (mode === "byte_limit") tail!.write(Buffer.alloc(64 * 1024 + 1, 32));
    if (mode === "closed") tail!.destroy();
    if (mode === "retired") await app.close();
    await expect.poll(() => records().length, { timeout: 2000 }).toBe(1);
    expect(records()[0]).toMatchObject({ outcome: "success", drain_outcome: mode, upstream_status: 200 });
    expect(Number(records()[0].request_closed_ms)).toBeGreaterThanOrEqual(Number(records()[0].result_settled_ms));
    if (mode !== "complete") await expect.poll(() => tail!.destroyed).toBe(true);
    if (mode !== "retired") expect((await fetchRecentLogs(app.url))[0]).toMatchObject({ output_tokens: 7, duration_ms: before.duration_ms, stream_outcome: "success" });
    expect(calls).toBe(1);
  });

  it.each([25, 20_000])("caps draining by both the remaining %sms request budget and the 500ms ceiling", async (budget) => {
    prepareEnvironment();
    const release = retainUpstreamProxyAgents();
    const upstream = await startHttpsClaudeUpstream((_req, res) => { res.writeHead(200); res.flushHeaders(); });
    const proxy = await startConnectProxy();
    const agent = resolveUpstreamAgent(new URL(upstream.url), proxy.url);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      https.get(upstream.url, { agent }, resolve).on("error", reject);
    });
    const outcomes: DrainOutcome[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(drainUpstreamResponse(agent, response, budget, (outcome) => outcomes.push(outcome))).toBe(true);
      const limit = Math.min(budget, 500);
      await vi.advanceTimersByTimeAsync(limit - 1);
      expect(outcomes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toEqual(["timeout"]);
      expect(response.destroyed).toBe(true);
    } finally { release(); response.destroy(); vi.useRealTimers(); }
  });

  it("bounds concurrent tails and only the last owner retires them", async () => {
    prepareEnvironment();
    const releaseFirst = retainUpstreamProxyAgents();
    const releaseLast = retainUpstreamProxyAgents();
    const upstream = await startHttpsClaudeUpstream((_req, res) => { res.writeHead(200); res.flushHeaders(); });
    const proxy = await startConnectProxy();
    const agent = resolveUpstreamAgent(new URL(upstream.url), proxy.url);
    const responses = await Promise.all(Array.from({ length: 9 }, () => new Promise<IncomingMessage>((resolve, reject) => {
      https.get(upstream.url, { agent }, resolve).on("error", reject);
    })));
    const outcomes: DrainOutcome[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const accepted = responses.map((response) => drainUpstreamResponse(agent, response, 2000, (outcome) => outcomes.push(outcome)));
      expect(accepted).toEqual([true, true, true, true, true, true, true, true, false]);
      expect(outcomes).toEqual(["capacity"]);
      releaseFirst();
      expect(outcomes).toEqual(["capacity"]);
      releaseLast();
      expect(outcomes).toEqual(["capacity", ...Array.from({ length: 8 }, () => "retired")]);
      expect(responses.slice(0, 8).every((response) => response.destroyed)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseFirst(); releaseLast();
      for (const response of responses) response.destroy();
      vi.useRealTimers();
    }
  });
});
