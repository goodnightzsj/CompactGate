import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import { ClaudeKeyPoolState } from "../src/server/claude-key-pool.js";
import { DIRECT_API_KEY_ID } from "../src/server/credentials.js";
import type { CompactGateConfig, UpstreamApiKey } from "../src/shared/types.js";

const HEADERS = { "x-claude-code-session-id": "session-1" };

describe("Claude key pool selection", () => {
  it("falls through untouched for profiles without a pool", () => {
    const { state, config } = setup([]);

    expect(state.select(config, "claude-a", HEADERS)).toBeNull();
  });

  it("leads the pool with the route's own key and rotates onto the added ones", () => {
    // The regression this pins: adding keys in the Studio used to *replace* the
    // key already configured, because every scheduler read `api_keys` and
    // stopped there. The direct key is member #1, so fill_first burns it first.
    const { state, config } = setup([key("k1", "sk-added-1"), key("k2", "sk-added-2")]);
    config.claude.primary.api_key = "sk-original";

    const first = state.select(config, "claude-a", HEADERS);
    expect(first?.keyId).toBe(DIRECT_API_KEY_ID);
    expect(first?.apiKey).toBe("sk-original");

    state.recordResult("claude-a", DIRECT_API_KEY_ID, { status: 401, responseHeaders: {} }, HEADERS);
    const second = state.select(config, "claude-a", HEADERS);
    expect(second?.keyId).toBe("k1");
    expect(second?.apiKey).toBe("sk-added-1");
  });

  it("schedules the direct key alone against one added key", () => {
    // One stored entry plus the direct key is a two-key pool, not the
    // "pool of one falls through" case.
    const { state, config } = setup([key("k1", "sk-added")]);
    config.claude.primary.api_key = "sk-original";

    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe(DIRECT_API_KEY_ID);
    state.recordResult("claude-a", DIRECT_API_KEY_ID, { status: 401, responseHeaders: {} }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
  });

  it("serves the first fill_first key and rotates only on a verdict", () => {
    const { state, config } = setup([
      key("k1", "sk-1"),
      key("k2", "sk-2")
    ]);

    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
    // A second new session still lands on k1 — no verdict yet.
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");

    state.recordResult("claude-a", "k1", { status: 401, responseHeaders: {} }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k2");
  });

  it("cools a budget-exhausted 402 like an auth verdict", () => {
    // one-api's "Budget pool quota has been exhausted" 402 must rotate the key
    // off the draw — leaving it out pinned every request to the dead key
    // because no other branch ever quarantined it.
    const { state, config } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);

    state.recordResult("claude-a", "k1", { status: 402, responseHeaders: {} }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k2");

    // Recovery is the same as auth: a success proves the budget was refilled.
    state.recordResult("claude-a", "k1", { status: 200, responseHeaders: {} }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
  });

  it("cools on 429 per Retry-After and recovers after it", () => {
    const { state, config, advance } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);

    state.recordResult("claude-a", "k1", {
      status: 429,
      responseHeaders: { "retry-after": "2" }
    }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k2");

    advance(2_100);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
  });

  it("never disables on 429 — a fresh quota cools, not kills", () => {
    const { state, config, advance } = setup([key("k1", "sk-1"), key("k2", "sk-2")], 1_000);
    const start = Date.now;

    for (let index = 0; index < 3; index += 1) {
      state.recordResult("claude-a", "k1", {
        status: 429,
        responseHeaders: { "retry-after": "2" }
      }, HEADERS);
      advance(2_001);
      expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
    }
    void start;
  });

  it("spreads new sessions across a spread pool", () => {
    const { config } = setup([key("k1", "sk-1"), key("k2", "sk-2"), key("k3", "sk-3")]);
    config.claude.primary.key_strategy = "spread";

    const picks = new Set<string>();
    // Sweep the roll evenly so every key gets a turn.
    let roll = 0;
    for (let index = 0; index < 60; index += 1) {
      roll = (roll + 0.017) % 1;
      const state = new ClaudeKeyPoolState({ now: () => 0, random: () => roll });
      picks.add(state.select(config, "claude-a", {})?.keyId ?? "");
    }

    expect(picks.size).toBe(3);
  });

  it("keeps a session pinned to the key that served it", () => {
    const { state, config } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);

    const first = state.select(config, "claude-a", HEADERS);
    expect(first?.keyId).toBe("k1");
    state.recordResult("claude-a", "k1", { status: 200, responseHeaders: {} }, HEADERS);

    // k1 is now cool for this session only; a fresh session still picks it.
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
    const fresh = state.select(config, "claude-a", { "x-claude-code-session-id": "session-2" });
    expect(fresh?.keyId).toBe("k1");

    // Kill k1; the pinned session must fall through to k2, then return after
    // the quarantine when the pin still points at a whole key.
    state.recordResult("claude-a", "k1", { status: 401, responseHeaders: {} }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k2");
  });

  it("broadens the transient window before cooling on repeated 5xx", () => {
    const { state, config, advance } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);

    // Two 502s: no cooldown yet — 5xx is ambiguous, it needs a window.
    state.recordResult("claude-a", "k1", { status: 502, responseHeaders: {} }, HEADERS);
    state.recordResult("claude-a", "k1", { status: 502, responseHeaders: {} }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");

    state.recordResult("claude-a", "k1", { status: 502, responseHeaders: {} }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k2");

    advance(60_100);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
  });

  it("ignores request-shape and model verdicts entirely", () => {
    const { state, config } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);

    state.recordResult("claude-a", "k1", { status: 400, responseHeaders: {} }, HEADERS);
    state.recordResult("claude-a", "k1", { status: 404, responseHeaders: {} }, HEADERS);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
  });

  it("resurrects a key on its first success", () => {
    const { state, config } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);

    state.recordResult("claude-a", "k1", { status: 401, responseHeaders: {} }, HEADERS);
    expect(state.blockState("claude-a", "k1")).not.toBeNull();
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k2");

    // A success proves the key whole again; the quarantine yields.
    state.recordResult("claude-a", "k1", { status: 200, responseHeaders: {} }, HEADERS);
    expect(state.blockState("claude-a", "k1")).toBeNull();
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
  });

  it("floods back to the soonest-unblocking key when every key is out", () => {
    const { state, config } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);

    state.recordResult("claude-a", "k1", { status: 401, responseHeaders: {} }, HEADERS);
    state.recordResult("claude-a", "k2", { status: 401, responseHeaders: {} }, HEADERS);
    // Both quarantined from the same instant — the fallback prefers the
    // earlier deadline, which is k1.
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
  });

  it("honours rotation_opt_out, which the Claude scope stored but never read", () => {
    const { state, config } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);
    config.claude.primary.rotation_opt_out = true;

    // A verdict against k1 would rotate a normal pool; opted out, the first
    // enabled key keeps carrying everything.
    state.recordResult("claude-a", "k1", { status: 401, responseHeaders: {} }, HEADERS, config);
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
  });

  it("reserves a recovered key for its own sessions for sticky_reserve_seconds", () => {
    const { state, config, advance } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);
    config.claude.primary.sticky_reserve_seconds = 60;
    const otherSession = { "x-claude-code-session-id": "session-2" };

    // Pin session-1 to k1, then rate-limit it.
    state.recordResult("claude-a", "k1", { status: 200, responseHeaders: {} }, HEADERS, config);
    state.recordResult("claude-a", "k1", {
      status: 429,
      responseHeaders: { "retry-after": "2" }
    }, HEADERS, config);

    advance(2_100);
    // Cooldown over, reserve still running: the pinned session returns to k1
    // while a different session is kept off it.
    expect(state.select(config, "claude-a", HEADERS)?.keyId).toBe("k1");
    expect(state.select(config, "claude-a", otherSession)?.keyId).toBe("k2");

    advance(60_000);
    expect(state.select(config, "claude-a", otherSession)?.keyId).toBe("k1");
  });

  it("evicts expired session pins instead of holding them for the process life", () => {
    const { state, config, advance } = setup([key("k1", "sk-1"), key("k2", "sk-2")]);

    state.recordResult("claude-a", "k1", { status: 200, responseHeaders: {} }, HEADERS, config);
    expect(state.stickinessSize()).toBe(1);

    // Past SESSION_STICKY_TTL_MS the pin is dropped on the next selection.
    advance(31 * 60 * 1000);
    state.select(config, "claude-a", { "x-claude-code-session-id": "session-9" });
    expect(state.stickinessSize()).toBe(0);
  });
});

function key(id: string, apiKey: string): UpstreamApiKey {
  return { id, label: "", api_key: apiKey, enabled: true };
}

function setup(
  pool: UpstreamApiKey[],
  startNow = 0
): { state: ClaudeKeyPoolState; config: CompactGateConfig; advance: (ms: number) => void } {
  let now = startNow;
  const config: CompactGateConfig = structuredClone(DEFAULT_CONFIG);
  config.claude.primary.api_keys = pool;
  return {
    state: new ClaudeKeyPoolState({
      now: () => now,
      // Deterministic mid-range roll so spread tests never land on a boundary.
      random: () => 0.5
    }),
    config,
    advance: (ms: number) => {
      now += ms;
    }
  };
}