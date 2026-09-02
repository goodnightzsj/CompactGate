import { createServer, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../src/shared/types.js";
import { RequestLogger } from "../src/server/logger.js";
import { rateLimitCooldownMs } from "../src/server/primary-failover-result.js";
import { providerStateConversationHash } from "../src/server/provider-state-binding.js";
import { StudioEventBroadcaster } from "../src/server/studio-events.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

async function makeLogger(): Promise<RequestLogger> {
  const logger = new RequestLogger(50, path.join(await makeConfigDir(), "logs.sqlite"));
  cleanups.push(() => logger.close());
  return logger;
}

describe("a Studio client that stops reading is dropped instead of buffered forever", () => {
  it("caps the per-client write buffer", async () => {
    const broadcaster = new StudioEventBroadcaster();
    const { server, responses } = await listen(broadcaster);
    const socket = await openUnreadSseSocket(server);

    // `res.write()` returning false is backpressure, not failure, and never throws
    // — so treating it as success meant nothing ever reaped this client and nothing
    // bounded its buffer. Measured 41 MB held for one dead tab after 40 broadcasts.
    const res = responses[0];
    expect(res).toBeTruthy();
    for (let round = 0; round < 80 && !res.writableEnded; round += 1) {
      broadcaster.broadcastLog(bulkyLogEntry(round));
    }

    expect(res.writableEnded).toBe(true);
    expect(res.writableLength).toBeLessThan(64 * 1024 * 1024);
    socket.destroy();
  });
});

describe("capture purge does its SQLite work in one batch", () => {
  it("purges many paths without a per-path read", async () => {
    const logger = await makeLogger();
    const paths = Array.from({ length: 30 }, (_, index) => `/captures/c-${index}.json`);
    for (const [index, capturePath] of paths.entries()) {
      logger.add(logEntryWithCapture(`req-${index}`, capturePath));
    }

    // Below the caller's threshold the entries are wanted, so they come back.
    const purged = logger.markCapturesPurged(paths, 50);
    expect(purged).toHaveLength(30);
    expect(purged.every((entry) => entry.capture_status === "purged")).toBe(true);
    expect(purged.every((entry) => entry.capture_path === null)).toBe(true);
  });

  it("skips the row read entirely when the caller will broadcast a snapshot", async () => {
    const logger = await makeLogger();
    const paths = Array.from({ length: 12 }, (_, index) => `/captures/s-${index}.json`);
    for (const [index, capturePath] of paths.entries()) {
      logger.add(logEntryWithCapture(`snap-${index}`, capturePath));
    }

    // Past the threshold the full-row SELECTs were pure waste: the caller discards
    // the entries and broadcasts one snapshot instead.
    expect(logger.markCapturesPurged(paths, 5)).toEqual([]);
    // The UPDATE still has to have happened.
    const purgedRow = logger.page({ limit: 50, offset: 0 }).logs
      .find((entry) => entry.request_id === "snap-0");
    expect(purgedRow?.capture_status).toBe("purged");
  });
});

describe("rate-limit cooldown never resolves to no cooldown at all", () => {
  it("falls back to the backoff when Retry-After says zero", () => {
    const now = Date.now();
    const zero = rateLimitCooldownMs(
      { responseHeaders: { "retry-after": "0" } } as never,
      11,
      now
    );
    // Zero used to mean the profile that had just crossed the failure threshold was
    // immediately eligible again and kept absorbing 429s.
    expect(zero).toBeGreaterThan(0);

    const honoured = rateLimitCooldownMs(
      { responseHeaders: { "retry-after": "30" } } as never,
      1,
      now
    );
    expect(honoured).toBe(30_000);
  });
});

describe("the conversation identity is the stable one", () => {
  it("prefers the session key over the per-turn continuation id", () => {
    const withBoth = providerStateConversationHash({
      sessionKey: "session-1",
      previousResponseId: "resp_turn_1"
    } as never);
    const nextTurn = providerStateConversationHash({
      sessionKey: "session-1",
      previousResponseId: "resp_turn_2"
    } as never);

    // Keyed on previous_response_id the two-strike counter could only ever be
    // reached by retrying one turn, and every turn logged a different hash.
    expect(withBoth).toBe(nextTurn);

    // A compaction item appearing mid-conversation must not switch the identity.
    expect(providerStateConversationHash({
      sessionKey: "session-1",
      compactionStateKey: "compaction-1",
      previousResponseId: "resp_turn_3"
    } as never)).toBe(withBoth);

    // With no session key at all there is still something to count on.
    expect(providerStateConversationHash({ previousResponseId: "resp_only" } as never))
      .not.toBeNull();
    expect(providerStateConversationHash({} as never)).toBeNull();
  });
});

function listen(
  broadcaster: StudioEventBroadcaster
): Promise<{ server: Server; responses: ServerResponse[] }> {
  const responses: ServerResponse[] = [];
  const server = createServer((req, res) => {
    responses.push(res);
    broadcaster.subscribe(req, res, { logs: [], stats: null } as never);
  });
  cleanups.push(() => server.close());
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, responses })));
}

function openUnreadSseSocket(server: Server): Promise<Socket> {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write("GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      // Never read: this is the suspended-laptop / zero-window client.
      socket.pause();
      setTimeout(() => resolve(socket), 60);
    });
  });
}

function bulkyLogEntry(round: number): RequestLogEntry {
  return {
    ...logEntryWithCapture(`bulk-${round}`, null),
    error_summary: "x".repeat(400_000)
  };
}

function logEntryWithCapture(requestId: string, capturePath: string | null): RequestLogEntry {
  return {
    time: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    route: "primary",
    method: "POST",
    path: "/v1/responses",
    endpoint: "/responses",
    request_type: "http",
    reasoning_effort: null,
    request_summary: null,
    incoming_request_body: null,
    upstream_request_body: null,
    upstream_response_body: null,
    client_response_body: null,
    body_status: "none",
    compact_response_normalized: false,
    compact_response_normalize_reason: null,
    compact_response_synthetic_source: null,
    source_model: "gpt-5",
    target_model: "gpt-5",
    response_model: null,
    status: 200,
    duration_ms: 1,
    first_token_ms: null,
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    cached_output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    reasoning_tokens: null,
    additive_cached_input_tokens: false,
    additive_cached_output_tokens: false,
    total_tokens: null,
    upstream_host: "primary.example",
    user_agent: null,
    key_name: null,
    request_id: requestId,
    error_summary: null,
    capture_path: capturePath,
    capture_status: capturePath ? "present" : "none"
  };
}
