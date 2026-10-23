import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createOpenAiStreamObserver, createAnthropicStreamObserver } from "../src/server/upstream-openai-stream.js";
import { createUpstreamTransportDiagnostics } from "../src/server/upstream-transport-diagnostics.js";
import { fetchRecentLogs, setEnv, startApp, startConnectProxy, startHttpsClaudeUpstream } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

function enableDiagnostics() {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) setEnv(key, "");
  setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
  setEnv("COMPACTGATE_TRANSPORT_DIAGNOSTICS", "1");
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  return () => output.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith('{"type":"upstream_transport"')) return [];
    return [JSON.parse(line) as Record<string, unknown>];
  });
}

describe("upstream transport diagnostics", () => {
  it.each(["", "0", "true"])("does not allocate a diagnostic record when the switch is %s", (value) => {
    setEnv("COMPACTGATE_TRANSPORT_DIAGNOSTICS", value);
    expect(createUpstreamTransportDiagnostics(new URL("https://example.test"), undefined, performance.now())).toBeNull();
  });

  it("reports actual cold and reused model attempts without secrets or body data", async () => {
    const samples = enableDiagnostics();
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "text/event-stream");
        res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7},"body":"response_secret"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const proxy = await startConnectProxy();
    const app = await startApp(undefined, undefined, {
      claude: { primary: { base_url: upstream.url, api_key: "credential_secret", proxy_url: proxy.url } }
    });
    const ids: Array<string | null> = [];
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${app.url}/anthropic/v1/messages?query_secret=yes`, {
        method: "POST", headers: { "content-type": "application/json", "x-test": "header_secret" },
        body: JSON.stringify({ model: "synthetic", messages: [{ role: "user", content: "request_secret" }], stream: true })
      });
      ids.push(response.headers.get("x-compactgate-request-id"));
      await response.text();
      await expect.poll(() => samples().length).toBe(i + 1);
    }
    const records = samples();
    expect(records.map((record) => record.reused_socket)).toEqual([false, true]);
    expect(records.map((record) => record.request_id)).toEqual(ids);
    expect(new Set(records.map((record) => record.attempt_id)).size).toBe(2);
    for (const record of records) {
      expect(record).toMatchObject({ outcome: "success", close_reason: "http_complete", upstream_status: 200, drain_outcome: null });
      for (const stage of ["socket_ready_ms", "request_sent_ms", "headers_ms", "first_body_byte_ms", "terminal_observed_ms", "http_end_ms", "result_settled_ms", "request_closed_ms"]) {
        expect(record[stage]).toEqual(expect.any(Number));
      }
      expect(Number(record.headers_ms)).toBeGreaterThanOrEqual(Number(record.socket_ready_ms));
      expect(Number(record.http_end_ms)).toBeGreaterThanOrEqual(Number(record.terminal_observed_ms));
    }
    expect(JSON.stringify(records)).not.toMatch(/credential_secret|query_secret|header_secret|request_secret|response_secret|\/v1\/messages/);
    expect(await fetchRecentLogs(app.url)).toHaveLength(2);
    expect(proxy.connectTargets).toHaveLength(1);
  });

  it("reports a failed CONNECT once without inventing response timings", async () => {
    const samples = enableDiagnostics();
    const proxy = await startConnectProxy({ closeBeforeConnectResponse: true });
    const app = await startApp(undefined, undefined, {
      claude: { primary: { base_url: "https://example.test", api_key: "synthetic", proxy_url: proxy.url } }
    });
    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"synthetic","messages":[]}'
    });
    expect(response.status).toBe(502);
    await response.text();
    await expect.poll(() => samples().length).toBe(1);
    expect(samples()[0]).toMatchObject({ outcome: "upstream_request_error", close_reason: "upstream_request_error", socket_ready_ms: null, headers_ms: null, first_body_byte_ms: null, http_end_ms: null });
  });

  it("keeps configured retry attempts separate from the logical request", async () => {
    const samples = enableDiagnostics();
    let calls = 0;
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.setHeader("retry-after", "0");
        if (++calls === 1) { res.writeHead(503); res.end('{"error":"synthetic unavailable"}'); }
        else res.end('{"id":"synthetic","object":"response.compaction","output":[]}');
      });
    });
    const proxy = await startConnectProxy();
    const app = await startApp(undefined, undefined, {
      compact: { base_url: upstream.url, api_key: "synthetic", proxy_url: proxy.url }
    });
    const response = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"synthetic","input":[]}'
    });
    await response.text();
    await expect.poll(() => samples().length).toBe(2);
    const records = samples();
    expect(records.map((record) => record.upstream_status)).toEqual([503, 200]);
    expect(new Set(records.map((record) => record.request_id)).size).toBe(1);
    expect(new Set(records.map((record) => record.attempt_id)).size).toBe(2);
    expect(calls).toBe(2);
  });

  it.each(["openai", "anthropic"])("notifies the first %s terminal after gzip decoding, only once", async (protocol) => {
    const onTerminalEvent = vi.fn();
    const create = protocol === "openai" ? createOpenAiStreamObserver : createAnthropicStreamObserver;
    const terminal = protocol === "openai" ? "response.completed" : "message_stop";
    const observer = create({ "content-type": "text/event-stream", "content-encoding": "gzip" }, { onTerminalEvent })!;
    observer.observe(gzipSync(`event: ${terminal}\ndata: {"type":"${terminal}"}\n\nevent: ${terminal}\ndata: {"type":"${terminal}"}\n\n`));
    expect((await observer.finish()).sawCompletedEvent).toBe(true);
    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
  });
});
