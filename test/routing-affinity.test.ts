import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { extractResponseUsage } from "../src/server/usage.js";
import type {
  CompactGateConfig,
  PrimaryReasoningEffort,
  SavedConfigProfile
} from "../src/shared/types.js";

/**
 * Codex routing affinity is per-session state living in one process-wide store.
 * These cover the ways an unrelated change used to reach across sessions and
 * take away a session's account pin, which costs it the whole prompt cache on
 * its next turn.
 */
describe("codex routing affinity is scoped to the profile that changed", () => {
  it("keeps a session pinned when a different profile's credential is rotated", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b")
    ]);
    const state = new PrimaryFailoverState({ random: () => 0 });

    const pinned = selectAndReserve(state, config, { sessionKey: "session-1" });
    expect(pinned.profileId).toBe("codex-a");
    expect(state.boundProfileId({ sessionKey: "session-1" })).toBe("codex-a");

    // The operator rotates the key on codex-b, which this session never used.
    const rotated = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b-rotated")
    ]);
    state.preview(rotated, { sessionKey: "session-2" });

    expect(state.boundProfileId({ sessionKey: "session-1" })).toBe("codex-a");
  });

  it("still drops the pin when the pinned profile itself changes", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b")
    ]);
    const state = new PrimaryFailoverState({ random: () => 0 });

    selectAndReserve(state, config, { sessionKey: "session-1" });
    expect(state.boundProfileId({ sessionKey: "session-1" })).toBe("codex-a");

    const rotated = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a-rotated"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b")
    ]);
    state.preview(rotated, { sessionKey: "session-2" });

    expect(state.boundProfileId({ sessionKey: "session-1" })).toBeNull();
  });

  it("keeps health for profiles that did not change", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b")
    ]);
    const state = new PrimaryFailoverState({ random: () => 0 });

    // Block codex-a on its first auth failure so selection falls through to codex-b.
    const selection = selectAndReserve(state, config, {});
    state.recordResult(selection, {
      status: 401,
      errorSummary: "Upstream returned HTTP 401: invalid token."
    });
    expect(state.preview(config, {}).profileId).toBe("codex-b");

    // Rotating codex-b must not resurrect codex-a's quarantine record.
    const rotated = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b-rotated")
    ]);
    expect(state.preview(rotated, {}).profileId).toBe("codex-b");
  });

  it("does not wipe stickiness when the applied profile is not a failover candidate", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      compactOnlyCodexProfile("codex-x", "Compact only")
    ]);
    const state = new PrimaryFailoverState({ random: () => 0 });

    selectAndReserve(state, config, { sessionKey: "session-1" });
    expect(state.boundProfileId({ sessionKey: "session-1" })).toBe("codex-a");

    // codex-x has no `primary` block, so it can never be selected. Forcing it
    // must not cost every other session its pin for nothing.
    state.forceNextProfileSelection(config, "codex-x");

    expect(state.boundProfileId({ sessionKey: "session-1" })).toBe("codex-a");
  });

  it("still forces and re-pins when the applied profile is a real candidate", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b")
    ]);
    const state = new PrimaryFailoverState({ random: () => 0 });

    selectAndReserve(state, config, { sessionKey: "session-1" });
    expect(state.boundProfileId({ sessionKey: "session-1" })).toBe("codex-a");

    state.forceNextProfileSelection(config, "codex-b");

    expect(state.boundProfileId({ sessionKey: "session-1" })).toBeNull();
    expect(state.preview(config, { sessionKey: "session-1" }).profileId).toBe("codex-b");
  });

  it("releases the in-flight reservation when an unrelated profile changed mid-request", () => {
    // Every finished request whose selection was reserved before an unrelated
    // config edit used to leak one inFlight, and each leaked unit is a
    // permanent -80 on that profile's score. codex-a leads codex-b by 1500
    // (order plus the active bonus), so ~19 leaks are enough to hand every
    // future request to codex-b even though codex-a never failed.
    const state = new PrimaryFailoverState({ random: () => 0 });
    let config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b")
    ]);

    for (let round = 0; round < 24; round += 1) {
      const selection = state.preview(config, {});
      expect(selection.profileId).toBe("codex-a");
      state.reserveSelection(selection, false);

      // The operator rotates codex-b's key while the codex-a request is open.
      config = configWithCodexProfiles([
        codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
        codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", `key-b-${round}`)
      ]);
      state.preview(config, {});
      state.recordResult(selection, 200);
    }

    expect(state.preview(config, {}).profileId).toBe("codex-a");
  });

  it("drops pins for a profile that was deleted from the candidate set", () => {
    const state = new PrimaryFailoverState({ random: () => 0 });
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b")
    ]);

    const selection = state.preview(config, { sessionKey: "session-1" });
    expect(selection.profileId).toBe("codex-a");
    state.reserveSelection(selection, true);
    expect(state.boundProfileId({ sessionKey: "session-1" })).toBe("codex-a");

    // codex-a is deleted. Its health goes with `reconcile`, but the pin used to
    // sit in the sticky map for the rest of its 30 minute TTL, holding an LRU
    // slot that a live session needs.
    const remaining = configWithCodexProfiles(
      [codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b")],
      "codex-b"
    );
    state.preview(remaining, {});

    expect(state.boundProfileId({ sessionKey: "session-1" })).toBeNull();
  });
});

describe("shared caches do not hand one request's state to another", () => {
  it("never returns the same empty usage object twice", () => {
    const first = extractResponseUsage(Buffer.alloc(0), {});
    const second = extractResponseUsage(Buffer.alloc(0), {});

    expect(first).not.toBe(second);
    // A caller mutating its own record must not reach any other request's.
    first.inputTokens = 4_242;
    expect(extractResponseUsage(Buffer.alloc(0), {}).inputTokens).toBeNull();
  });

  it("strips set-cookie from a replayed compact response", () => {
    const bridge = new CompactionBridgeStore({});
    const input = {
      upstream: new URL("https://upstream.test/v1/responses/compact"),
      authorization: "Bearer session-a-token",
      body: Buffer.from("{\"model\":\"gpt-5.5\"}")
    };
    bridge.storeCompactDedupeResponse(input, {
      status: 200,
      responseBody: Buffer.from("data: {}\n\n"),
      responseHeaders: {
        "content-type": "text/event-stream",
        "set-cookie": ["session=session-a-secret; Path=/"]
      },
      clientResponseBody: Buffer.from("{}"),
      clientResponseHeaders: { "content-type": "application/json" },
      compactResponseNormalized: false,
      compactResponseNormalizeReason: null,
      compactResponseSyntheticSource: null,
      firstTokenMs: 12
    });

    const replayed = bridge.getCachedCompactResponse(input);
    expect(replayed).not.toBeNull();
    expect(replayed?.responseHeaders["set-cookie"]).toBeUndefined();
    expect(replayed?.responseHeaders["content-type"]).toBe("text/event-stream");
  });
});

function selectAndReserve(
  state: PrimaryFailoverState,
  config: CompactGateConfig,
  context: { sessionKey?: string; model?: string }
) {
  const selection = state.preview(config, context);
  state.reserveSelection(selection, true);
  return selection;
}

function configWithCodexProfiles(
  profiles: SavedConfigProfile[],
  activeProfileId = profiles[0]?.id ?? null
): CompactGateConfig {
  return {
    ...cloneConfig(DEFAULT_CONFIG),
    profile_scopes: {
      codex: { profiles, active_profile_id: activeProfileId },
      claude: { profiles: [], active_profile_id: null }
    }
  };
}

function codexProfile(
  id: string,
  name: string,
  primaryBaseUrl: string,
  primaryApiKey = DEFAULT_CONFIG.primary.api_key,
  reasoningEffort: PrimaryReasoningEffort = DEFAULT_CONFIG.primary.reasoning_effort
): SavedConfigProfile {
  return {
    id,
    name,
    created_at: "2026-06-06T00:00:00.000Z",
    updated_at: "2026-06-06T00:00:00.000Z",
    config: {
      primary: {
        ...DEFAULT_CONFIG.primary,
        base_url: primaryBaseUrl,
        api_key: primaryApiKey,
        reasoning_effort: reasoningEffort
      },
      compact: { ...DEFAULT_CONFIG.compact }
    }
  };
}

function compactOnlyCodexProfile(id: string, name: string): SavedConfigProfile {
  return {
    id,
    name,
    created_at: "2026-06-06T00:00:00.000Z",
    updated_at: "2026-06-06T00:00:00.000Z",
    // The type demands `primary`, but configs are read back from JSON on disk,
    // so a hand-edited or pre-migration file can still carry a codex profile
    // without one. That is why codexPrimaryCandidates guards for it at runtime.
    config: { compact: { ...DEFAULT_CONFIG.compact } } as SavedConfigProfile["config"]
  };
}

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}
