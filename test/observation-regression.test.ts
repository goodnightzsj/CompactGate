import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyClaudeRequest } from "../src/server/claude-proxy.js";
import { ClientIdentityStore } from "../src/server/client-identity-store.js";
import { CodexVersionMonitor } from "../src/server/codex-version.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import type { ConfigStore } from "../src/server/config.js";
import type { DebugCaptureWriter } from "../src/server/debug-capture.js";
import { RequestLogger } from "../src/server/logger.js";
import { proxyOpenAiRequest } from "../src/server/openai-proxy.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { StudioEventBroadcaster } from "../src/server/studio-events.js";
import { createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";
import { extractResponseUsage } from "../src/server/usage.js";

interface PeerResponse { headers: IncomingHttpHeaders; body: Buffer }
let peerResponse: PeerResponse;
let peerPaths: string[];
const cleanup: Array<() => Promise<void>> = [];

// Only the HTTP peer is replaced: routing, stream decoding, settlement, SQLite
// persistence and analytics use the real implementations, without opening ports.
beforeEach(() => {
  peerPaths = [];
  vi.spyOn(http, "request").mockImplementation(((url: URL, _options: unknown, onResponse: (response: IncomingMessage) => void) => {
    expect(url.hostname).toBe("synthetic.invalid");
    peerPaths.push(url.pathname);
    const responseFixture = peerResponse;
    const request = new EventEmitter();
    return Object.assign(request, {
      destroy: () => request,
      end: () => setImmediate(() => {
        const response = Object.assign(new PassThrough(), { statusCode: 200, headers: responseFixture.headers });
        onResponse(response as unknown as IncomingMessage);
        response.end(responseFixture.body);
      })
    });
  }) as unknown as typeof http.request);
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("Unexpected HTTPS request in synthetic test."); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

class ResponseSink extends Writable {
  headersSent = false;
  statusCode = 0;
  readonly headers = new Map<string, unknown>();
  readonly chunks: Buffer[] = [];
  constructor() { super({ autoDestroy: false }); }
  setHeader(name: string, value: unknown) { this.headers.set(name.toLowerCase(), value); }
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { this.chunks.push(Buffer.from(chunk)); done(); }
}

function syntheticConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const route of [config.primary, config.compact, config.claude.primary, config.claude.compact]) {
    route.api_key = "synthetic-not-a-credential";
    route.api_key_env = "";
    route.base_url = "http://synthetic.invalid/v1";
  }
  config.primary_failover.auto_schedule = false;
  config.primary_failover.state_portability = "off";
  return config;
}

async function harness(config = syntheticConfig()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compactgate-observation-"));
  const logger = new RequestLogger(20, path.join(directory, "logs.sqlite"));
  const events = new StudioEventBroadcaster();
  const monitor = new CodexVersionMonitor({ probe: () => null });
  const identity = new ClientIdentityStore({ statePath: path.join(directory, "identity.json"), fetchLatestVersion: async () => null });
  cleanup.push(async () => {
    monitor.close(); identity.close(); await identity.flush(); logger.close(); events.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = { get: () => config, revision: "synthetic-1" } as unknown as ConfigStore;
  const captures = { isEnabled: () => false } as unknown as DebugCaptureWriter;
  const bridge = new CompactionBridgeStore();
  const failover = new PrimaryFailoverState();
  const from = new Date(Date.now() - 60_000).toISOString();
  return {
    async invoke(endpoint: string, body: object, headers: IncomingHttpHeaders = {}) {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        socket: { remoteAddress: "127.0.0.1" }, complete: true
      }) as unknown as IncomingMessage;
      const sink = new ResponseSink();
      const res = sink as unknown as ServerResponse;
      const url = new URL(endpoint, "http://gateway.invalid");
      if (endpoint.startsWith("/anthropic/")) await proxyClaudeRequest(req, res, url, store, logger, captures, events);
      else await proxyOpenAiRequest(req, res, url, store, logger, captures, bridge, events, failover, monitor, identity);
      const entry = logger.recent()[0];
      expect(entry, "the proxy must persist the completed request").toBeDefined();
      expect(entry.error_summary).toBeNull();
      expect(sink.statusCode).toBe(200);
      return { entry, body: Buffer.concat(sink.chunks) };
    },
    stats: () => logger.stats({ from, to: new Date(Date.now() + 60_000).toISOString() }).summary
  };
}

const requestBody = { model: "synthetic-model", input: "synthetic", messages: [{ role: "user", content: "synthetic" }] };

describe("request accounting is separate from estimates and cache replays", () => {
  it.each([
    ["/anthropic/v1/messages/count_tokens", "anthropic_messages", "/v1/messages/count_tokens"],
    ["/anthropic/messages/count_tokens", "anthropic_messages", "/v1/messages/count_tokens"],
    ["/anthropic/v1/messages/count_tokens", "openai_responses", "/v1/responses/input_tokens"],
    ["/v1/responses/input_tokens", "openai_responses", "/v1/responses/input_tokens"]
  ] as const)("counts %s via %s as a request, not generation usage", async (endpoint, protocol, upstreamPath) => {
    const config = syntheticConfig();
    config.claude.primary.upstream_protocol = protocol;
    const proxy = await harness(config);
    peerResponse = { headers: { "content-type": "application/json" }, body: Buffer.from('{"input_tokens":100000}') };
    const { entry, body } = await proxy.invoke(endpoint, requestBody);
    expect(peerPaths).toEqual([upstreamPath]);
    expect(JSON.parse(body.toString())).toMatchObject({ input_tokens: 100000 });
    expect.soft(entry).toMatchObject({ input_tokens: null, output_tokens: null, total_tokens: null });
    expect(proxy.stats()).toMatchObject({ requests: 1, normal_requests: 1, error_requests: 0, usage_observed_requests: 0, input_tokens: 0, total_tokens: 0 });
  });

  it("does not reuse upstream latency or charge usage again on a Remote V1 cache hit", async () => {
    const proxy = await harness();
    peerResponse = { headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({
      object: "response.compaction", output: [{ type: "compaction", encrypted_content: "synthetic-state" }],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
    })) };
    const first = await proxy.invoke("/v1/responses/compact", requestBody);
    const replay = await proxy.invoke("/v1/responses/compact", requestBody);
    expect(peerPaths).toEqual(["/v1/responses/compact"]);
    expect(replay.body).toEqual(first.body);
    expect(first.entry.first_token_ms).toBeGreaterThanOrEqual(0);
    expect.soft(replay.entry.first_token_ms).toBeNull();
    expect(replay.entry.total_tokens).toBeNull();
    expect(proxy.stats()).toMatchObject({ requests: 2, usage_observed_requests: 1, input_tokens: 100, output_tokens: 20, total_tokens: 120 });
  });
});

// Every frame is small and the normal start/content/end sequence is present.
// The compressed transport is valid; only whole-body diagnostic decoding hits
// its separate 8 MiB limit. Cached counts are inclusive in OpenAI and additive
// in Anthropic, so the conversion controls also catch cross-protocol mixing.
function streamFixture(protocol: "openai" | "anthropic", outputTokens: number, compressed = true): PeerResponse {
  let sequence = 0;
  const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({
    type, ...(protocol === "openai" ? { sequence_number: sequence++ } : {}), ...data
  })}\n\n`;
  const frames: string[] = [];
  if (protocol === "openai") {
    const part = { type: "output_text", text: "x".repeat(outputTokens), annotations: [], logprobs: [] };
    const item = { type: "message", id: "msg_synthetic", status: "completed", role: "assistant", content: [part] };
    const response = { id: "resp_synthetic", object: "response", created_at: 1791360000, model: "synthetic-model", status: "in_progress", output: [], usage: null };
    frames.push(frame("response.created", { response }));
    frames.push(frame("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }));
    frames.push(frame("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } }));
    for (let index = 0; index < outputTokens; index++) frames.push(frame("response.output_text.delta", {
      item_id: item.id, output_index: 0, content_index: 0, delta: "x", logprobs: []
    }));
    frames.push(frame("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: part.text, logprobs: [] }));
    frames.push(frame("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part }));
    frames.push(frame("response.output_item.done", { output_index: 0, item }));
    frames.push(frame("response.completed", { response: { ...response, status: "completed", output: [item], usage: {
      input_tokens: 823, output_tokens: outputTokens, total_tokens: 823 + outputTokens,
      input_tokens_details: { cached_tokens: 500, cache_write_tokens: 200 }
    } } }));
  } else {
    frames.push(frame("message_start", { message: { id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic-model", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 123, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 } } }));
    frames.push(frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    for (let index = 0; index < outputTokens; index++) frames.push(frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }));
    frames.push(frame("content_block_stop", { index: 0 }));
    frames.push(frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } }));
    frames.push(frame("message_stop", {}));
  }
  const plain = Buffer.from(frames.join(""));
  expect(plain.length).toBeGreaterThan(8 * 1024 * 1024);
  return {
    headers: { "content-type": "text/event-stream", ...(compressed ? { "content-encoding": "gzip" } : {}) },
    body: compressed ? gzipSync(plain) : plain
  };
}

describe("compressed stream accounting keeps observed usage in the client protocol", () => {
  it.each(["primary", "compact"] as const)("persists known usage beyond the diagnostic limit on the %s path", async (route) => {
    const proxy = await harness();
    peerResponse = streamFixture("openai", 50_000);
    const observer = createOpenAiStreamObserver(peerResponse.headers);
    if (!observer) throw new Error("Expected stream observer.");
    observer.observe(peerResponse.body);
    expect(await observer.finish()).toMatchObject({ decodeError: false, oversizedEventCount: 0, usage: { totalTokens: 50_823 } });
    expect(extractResponseUsage(peerResponse.body, peerResponse.headers).totalTokens).toBeNull();
    const { entry } = await proxy.invoke("/v1/responses", { ...requestBody, stream: true }, route === "compact"
      ? { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) } : {});
    expect(entry).toMatchObject({ route, stream_outcome: "success", upstream_response_truncated: false });
    expect.soft(entry).toMatchObject({ input_tokens: 823, output_tokens: 50_000, total_tokens: 50_823, cached_input_tokens: 500, cache_creation_input_tokens: 200, additive_cached_input_tokens: false });
    expect(proxy.stats()).toMatchObject({ requests: 1, usage_observed_requests: 1, input_tokens: 823, output_tokens: 50_000, total_tokens: 50_823, cache_read_tokens: 500, cache_creation_tokens: 200 });
  });

  it.each([
    ["native Claude", "anthropic", "/anthropic/v1/messages", 80_000, 123, true],
    ["Anthropic to Responses", "anthropic", "/v1/responses", 80_000, 823, false],
    ["Responses to Anthropic", "openai", "/anthropic/v1/messages", 50_000, 123, true]
  ] as const)("preserves cache and input semantics for %s", async (_name, protocol, endpoint, outputTokens, inputTokens, additive) => {
    const config = syntheticConfig();
    config.primary.upstream_protocol = "anthropic_messages";
    config.claude.primary.upstream_protocol = protocol === "openai" ? "openai_responses" : "anthropic_messages";
    const proxy = await harness(config);
    // Converting routes request identity and reject encoded responses; native
    // Claude passthrough is the control that supports gzip decoding.
    peerResponse = streamFixture(protocol, outputTokens, protocol === "anthropic" && endpoint.startsWith("/anthropic/"));
    const { entry } = await proxy.invoke(endpoint, { ...requestBody, stream: true });
    expect.soft(entry).toMatchObject({ stream_outcome: "success", input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: 823 + outputTokens, cache_creation_input_tokens: 200, additive_cached_input_tokens: additive });
    expect(proxy.stats()).toMatchObject({ requests: 1, usage_observed_requests: 1, input_tokens: 823, output_tokens: outputTokens, total_tokens: 823 + outputTokens, cache_read_tokens: 500, cache_creation_tokens: 200 });
  });
});
