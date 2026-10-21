import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { measureUpstreamLatency } from "../scripts/upstream-latency.js";
import { setEnv, startConnectProxy, startHttpsClaudeUpstream } from "./helpers/server-test-utils.js";

describe("upstream latency probe", () => {
  it("reports cold/warm phases without sending auth or retaining response bodies", async () => {
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      res.end("synthetic response");
    });
    const proxy = await startConnectProxy();
    const samples = await measureUpstreamLatency(upstream.url, proxy.url);
    expect(samples.map((sample) => sample.reused_socket)).toEqual([false, true, true]);
    expect(proxy.connectTargets).toHaveLength(1);
    for (const sample of samples) {
      expect(sample.status).toBe(200);
      expect(sample.bytes).toBe(Buffer.byteLength("synthetic response"));
      expect(sample.socket_ready_ms).toBeGreaterThanOrEqual(0);
      expect(sample.request_sent_ms).toBeGreaterThanOrEqual(sample.socket_ready_ms);
      expect(sample.headers_ms).toBeGreaterThanOrEqual(sample.request_sent_ms);
      expect(sample.first_body_byte_ms).toBeGreaterThanOrEqual(sample.headers_ms);
      expect(sample.total_ms).toBeGreaterThanOrEqual(sample.first_body_byte_ms!);
      expect(sample.body_ms).toBe(sample.total_ms - sample.headers_ms);
      expect(sample).not.toHaveProperty("body");
    }
  });

  it.each([
    ["not-a-url", "http://127.0.0.1:1"],
    ["http://example.test/", "http://127.0.0.1:1"],
    ["https://user:synthetic@example.test/", "http://127.0.0.1:1"],
    ["https://example.test/?token=synthetic", "http://127.0.0.1:1"],
    ["https://example.test/#synthetic", "http://127.0.0.1:1"],
    ["https://example.test/", "http://user:synthetic@127.0.0.1:1"],
    ["https://example.test/", "https://127.0.0.1:1"]
  ])("rejects unsupported or credential-bearing URLs before network I/O (%s)", async (target, proxy) => {
    await expect(measureUpstreamLatency(target, proxy)).rejects.toMatchObject({ code: "PROBE_INVALID_URL" });
  });

  it("limits response bytes and closes the failed tunnel without retrying", async () => {
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    let socketClosed = Promise.resolve<unknown>(undefined);
    let calls = 0;
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      calls++;
      socketClosed = once(req.socket, "close");
      res.end(Buffer.alloc(1024 * 1024 + 1));
    });
    const proxy = await startConnectProxy();
    await expect(measureUpstreamLatency(upstream.url, proxy.url)).rejects.toMatchObject({
      message: "Probe response exceeds 1 MiB.", code: "PROBE_RESPONSE_TOO_LARGE"
    });
    await socketClosed;
    expect(calls).toBe(1);
    expect(proxy.connectTargets).toHaveLength(1);
  });
});
