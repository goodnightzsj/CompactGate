import { once } from "node:events";
import https from "node:https";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveUpstreamAgent } from "../src/server/upstream-proxy-agent.js";
import { requestJson } from "../src/server/upstream-json-client.js";
import { setEnv, startApp, startConnectProxy, startHttpsClaudeUpstream } from "./helpers/server-test-utils.js";

function clearProxyEnvironment(): void {
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy"
  ]) {
    setEnv(key, "");
  }
}

describe("upstream proxy agent", () => {
  it("reuses one CONNECT tunnel for sequential POST and GET requests", async () => {
    clearProxyEnvironment();
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const bodies: string[] = [];
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString());
        res.end('{"ok":true}');
      });
    });
    const proxy = await startConnectProxy();
    const target = new URL(upstream.url);
    const agent = resolveUpstreamAgent(target, proxy.url);
    const reused: boolean[] = [];
    for (const method of ["POST", "POST", "GET"]) {
      await new Promise<void>((resolve, reject) => {
        const req = https.request(target, { method, agent }, (res) => {
          reused.push(req.reusedSocket);
          res.resume();
          res.on("end", resolve);
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end(method === "POST" ? "synthetic" : undefined);
      });
      await nextTurn();
    }
    expect(bodies).toEqual(["synthetic", "synthetic", ""]);
    expect(reused).toEqual([false, true, true]);
    expect(proxy.connectTargets).toEqual([target.host]);
  });

  it("expires an idle tunnel without expiring a reused active request", async () => {
    clearProxyEnvironment();
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    let finishResponse: () => void = () => {};
    let responseStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { responseStarted = resolve; });
    let socketClosed = Promise.resolve<unknown>(undefined);
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      socketClosed = once(req.socket, "close");
      res.setHeader("content-type", "application/json");
      if (req.url === "/slow") {
        res.write('{"ok":');
        finishResponse = () => res.end("true}");
        responseStarted();
      } else res.end('{"ok":true}');
    });
    const proxy = await startConnectProxy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(await requestJson(new URL(upstream.url), {}, 10_000, { proxyUrl: proxy.url })).toEqual({ ok: true });
      await nextTurn();
      const slow = requestJson(new URL("/slow", upstream.url), {}, 10_000, { proxyUrl: proxy.url });
      await started;
      await vi.advanceTimersByTimeAsync(4_001);
      finishResponse();
      expect(await slow).toEqual({ ok: true });
      await nextTurn();
      expect(proxy.connectTargets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4_001);
      await socketClosed;
      expect(await requestJson(new URL(upstream.url), {}, 10_000, { proxyUrl: proxy.url })).toEqual({ ok: true });
      expect(proxy.connectTargets).toHaveLength(2);
    } finally {
      finishResponse();
      vi.useRealTimers();
    }
  });

  it("keeps at most two idle tunnels to one target", async () => {
    clearProxyEnvironment();
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const responses: Array<() => void> = [];
    let allStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { allStarted = resolve; });
    const upstream = await startHttpsClaudeUpstream((_req, res) => {
      responses.push(() => res.end('{"ok":true}'));
      if (responses.length === 4) allStarted();
    });
    const proxy = await startConnectProxy();
    const target = new URL(upstream.url);
    const requests = Array.from({ length: 4 }, () => requestJson(target, {}, 2_000, { proxyUrl: proxy.url }));
    await started;
    responses.forEach((finish) => finish());
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 4 }, () => ({ ok: true })));
    await nextTurn();
    const agent = resolveUpstreamAgent(target, proxy.url)!;
    expect(Object.values(agent.freeSockets).flat()).toHaveLength(2);
    expect(proxy.connectTargets).toHaveLength(4);
  });

  it("closes cached idle tunnels when retiring them", async () => {
    clearProxyEnvironment();
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    let socketClosed = Promise.resolve<unknown>(undefined);
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      socketClosed = once(req.socket, "close");
      res.end('{"ok":true}');
    });
    const proxy = await startConnectProxy();
    const target = new URL(upstream.url);
    const old = resolveUpstreamAgent(target, proxy.url);
    await requestJson(target, {}, 2_000, { proxyUrl: proxy.url });
    await nextTurn();
    for (let i = 0; i < 8; i++) resolveUpstreamAgent(target, `http://idle-eviction-${i}.example.test:8080`);
    await socketClosed;
    expect(resolveUpstreamAgent(target, proxy.url)).not.toBe(old);
    await requestJson(target, {}, 2_000, { proxyUrl: proxy.url });
    expect(proxy.connectTargets).toHaveLength(2);
  });

  it("bounds total idle tunnels across targets and isolates proxies", async () => {
    clearProxyEnvironment();
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const proxy = await startConnectProxy();
    const targets: URL[] = [];
    for (let i = 0; i < 10; i++) {
      const upstream = await startHttpsClaudeUpstream((_req, res) => res.end('{"ok":true}'));
      const target = new URL(upstream.url);
      targets.push(target);
      await requestJson(target, {}, 2_000, { proxyUrl: proxy.url });
      await nextTurn();
    }
    const agent = resolveUpstreamAgent(targets[0], proxy.url)!;
    const idle = Object.values(agent.freeSockets).flat().filter((socket) => socket && !socket.destroyed);
    expect(idle).toHaveLength(8);
    expect(proxy.connectTargets).toEqual(targets.map((target) => target.host));
    const otherProxy = await startConnectProxy();
    expect(resolveUpstreamAgent(targets[9], otherProxy.url)).not.toBe(agent);
    await requestJson(targets[9], {}, 2_000, { proxyUrl: otherProxy.url });
    expect(otherProxy.connectTargets).toEqual([targets[9].host]);
  });

  it("keeps TLS verification enabled when using a CONNECT proxy", async () => {
    clearProxyEnvironment();
    const upstream = await startHttpsClaudeUpstream((_req, res) => res.end('{"ok":true}'));
    const proxy = await startConnectProxy();
    await expect(requestJson(new URL(upstream.url), {}, 2_000, { proxyUrl: proxy.url })).rejects.toMatchObject({
      code: "DEPTH_ZERO_SELF_SIGNED_CERT"
    });
    expect(proxy.connectTargets).toHaveLength(1);
  });

  it("keeps the shared tunnel through one server shutdown and releases it after the last", async () => {
    clearProxyEnvironment();
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    let calls = 0;
    let finishResponse: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let socketClosed = Promise.resolve<unknown>(undefined);
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      socketClosed = once(req.socket, "close");
      req.on("end", () => {
        calls++;
        res.setHeader("content-type", "application/json");
        const finish = () => res.end('{"id":"synthetic","object":"response","output":[],"usage":{"output_tokens":3}}');
        if (calls === 2) { finishResponse = finish; markStarted(); }
        else finish();
      });
    });
    const proxy = await startConnectProxy();
    const patch = { primary: { api_key: "synthetic", proxy_url: proxy.url } };
    const first = await startApp(`${upstream.url}/v1`, undefined, patch);
    const second = await startApp(`${upstream.url}/v1`, undefined, patch);
    const send = async (url: string) => {
      const response = await fetch(`${url}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "synthetic", input: "hello" })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty("usage.output_tokens", 3);
      await nextTurn();
    };
    await send(first.url);
    const active = send(second.url);
    await started;
    await first.close();
    finishResponse();
    await active;
    await send(second.url);
    expect(proxy.connectTargets).toHaveLength(1);
    await second.close();
    await socketClosed;
  });

  it.each(["json", "stream"])("lets an evicted agent finish its %s response and close its socket", async (mode) => {
    clearProxyEnvironment();
    // Only the local HTTPS fixture uses a self-signed certificate.
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    let finishResponse: () => void = () => {};
    let socketClosed: Promise<unknown> = Promise.resolve();
    let markResponseStarted: () => void = () => {};
    const responseStarted = new Promise<void>((resolve) => { markResponseStarted = resolve; });
    const prefix = mode === "json" ? '{"ok":' : 'data: {"type":"response.created"}\n\n';
    const suffix = mode === "json" ? "true}" : 'data: {"type":"response.completed","response":{"id":"synthetic","output":[]}}\n\n';
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      socketClosed = once(req.socket, "close");
      res.writeHead(200, { "content-type": mode === "json" ? "application/json" : "text/event-stream" });
      res.write(prefix);
      finishResponse = () => res.end(suffix);
      markResponseStarted();
    });
    const proxy = await startConnectProxy();
    const target = new URL(upstream.url);
    const agent = resolveUpstreamAgent(target, proxy.url);
    expect(resolveUpstreamAgent(target, proxy.url)).toBe(agent);
    const app = mode === "stream" ? await startApp(`${upstream.url}/v1`, undefined, {
      primary: { api_key: "synthetic", proxy_url: proxy.url }
    }) : null;
    const request = app
      ? fetch(`${app.url}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "synthetic", input: "hello", stream: true }),
          signal: AbortSignal.timeout(2_000)
        }).then(async (response) => ({ status: response.status, body: await response.text() }))
      : requestJson(target, {}, 2_000, { proxyUrl: proxy.url });
    const result = request.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await responseStarted;

    // Fill the eight-entry cache without opening unrelated network connections.
    for (let index = 0; index < 8; index += 1) {
      resolveUpstreamAgent(target, `http://eviction-${mode}-${index}.example.test:8080`);
    }
    expect(resolveUpstreamAgent(target, proxy.url)).not.toBe(agent);
    finishResponse();

    expect(await result).toEqual({
      value: mode === "json" ? { ok: true } : { status: 200, body: prefix + suffix }
    });
    await socketClosed;
    expect(proxy.connectTargets).toEqual([target.host]);
  });

  it("lets an explicit proxy override environment and NO_PROXY", () => {
    clearProxyEnvironment();
    setEnv("HTTPS_PROXY", "not-a-valid-proxy-url");
    setEnv("NO_PROXY", "*");

    expect(resolveUpstreamAgent(
      new URL("https://api.example.test/v1"),
      "http://127.0.0.1:8080"
    )).toBeDefined();
  });

  it("fails closed for invalid configured or environment proxies", () => {
    clearProxyEnvironment();
    expect(() => resolveUpstreamAgent(
      new URL("https://api.example.test/v1"),
      "https://127.0.0.1:8080"
    )).toThrow("must be an http URL without a path, query, or fragment");
    expect(() => resolveUpstreamAgent(
      new URL("http://api.example.test/v1"),
      "http://127.0.0.1:8080"
    )).toThrow("requires an HTTPS upstream");

    setEnv("HTTPS_PROXY", "not-a-valid-proxy-url");
    expect(() => resolveUpstreamAgent(new URL("https://api.example.test/v1"))).toThrow(
      "HTTPS proxy environment is invalid"
    );
  });
});
