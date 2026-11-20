import net from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { requestJson } from "../src/server/upstream-json-client.js";
import { resolveUpstreamAgent, retainUpstreamProxyAgents } from "../src/server/upstream-proxy-agent.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["::1", "127.0.0.1"])("connects through %s and brackets an IPv6 CONNECT authority", async host => {
  const release = retainUpstreamProxyAgents();
  let received = "";
  const proxy = net.createServer(socket => socket.once("data", bytes => {
    received = bytes.toString();
    socket.end("HTTP/1.1 502 Synthetic Proxy Reached\r\nContent-Length: 0\r\n\r\n");
  }));
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, host, resolve); });
  const port = (proxy.address() as net.AddressInfo).port;
  try {
    await expect(requestJson(new URL("https://[::1]:9443/v1"), {}, 1_000,
      { proxyUrl: `http://${host === "::1" ? "[::1]" : host}:${port}` })).rejects.toThrow("Synthetic Proxy Reached");
    expect(received).toContain("CONNECT [::1]:9443 HTTP/1.1\r\nHost: [::1]:9443\r\n");
  } finally {
    release();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

it.each([["[::1]:9443", true], ["[::1]:9444", false], ["[::1]", true], ["::1", true], ["[::2]:9443", false]] as const)(
  "matches NO_PROXY=%s with correct port semantics", (pattern, bypass) => {
    const release = retainUpstreamProxyAgents();
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("NO_PROXY", pattern);
    try {
      const target = new URL("https://[::1]:9443/v1");
      expect(resolveUpstreamAgent(target) === undefined).toBe(bypass);
      expect(resolveUpstreamAgent(target, "http://127.0.0.1:2")).toBeDefined();
    } finally { release(); }
  }
);
