import { once } from "node:events";
import { describe, expect, it } from "vitest";
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
