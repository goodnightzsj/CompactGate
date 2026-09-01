import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import { mergeRuntimeConfig, validateRuntimeConfig } from "../src/server/config-runtime.js";
import { resolveRouteCredential } from "../src/server/credentials.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import {
  candidateSignature,
  codexPrimaryCandidates
} from "../src/server/primary-failover-candidates.js";
import {
  stateDomainForPrimary,
  stateDomainForProfile
} from "../src/server/provider-state-domain.js";
import type {
  CompactGateConfig,
  PrimaryKeyStrategy,
  SavedConfigProfile,
  UpstreamApiKey
} from "../src/shared/types.js";

const AUTH_ERROR = "Upstream returned HTTP 401: invalid token.";

describe("primary key pool candidates", () => {
  it("expands one pooled profile into one candidate per enabled key", () => {
    const config = configWithKeyPool("codex-a", "Codex A", [
      key("key-1", "主号", "sk-first"),
      key("key-2", "备用", "sk-second"),
      disabledKey("key-3", "停用", "sk-third")
    ]);

    const candidates = codexPrimaryCandidates(config);

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "codex-a#key-1",
      "codex-a#key-2"
    ]);
    expect(candidates.map((candidate) => candidate.config.primary.api_key)).toEqual([
      "sk-first",
      "sk-second"
    ]);
    expect(candidates.map((candidate) => candidate.keyId)).toEqual(["key-1", "key-2"]);
    expect(candidates.map((candidate) => candidate.keyLabel)).toEqual(["主号", "备用"]);
    // Every key of the active profile shares the active bonus — marking only
    // the first would push its siblings out of the top-K window. Non-active
    // profiles never receive it.
    expect(candidates.every((candidate) => candidate.active)).toBe(true);
  });

  it("keeps the plain profile id for a profile without a pool", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "https://api.example.test/v1", "sk-single")
    ]);

    const candidates = codexPrimaryCandidates(config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("codex-a");
    expect(candidates[0].profileId).toBe("codex-a");
    expect(candidates[0].keyId).toBeNull();
  });

  it("gives every fill_first key a unique order, grouped after its profile", () => {
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")]),
      pooledProfile("codex-b", "B", [key("k3", "", "sk-3")])
    ]);

    const orders = codexPrimaryCandidates(config).map((candidate) => candidate.order);

    // A's keys are 0 and 1, B's key is 2 — never A#k2 == B#k1, which would blend
    // two profiles into one top-K weighted window.
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual([0, 1, 2]);
  });

  it("shares one order across a spread profile's keys", () => {
    const config = configWithCodexProfiles([
      {
        ...pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2"), key("k3", "", "sk-3")])
      }
    ]);
    // The strategy lives on the profile — like base_url and api_key, the saved
    // profile's value wins over the runtime primary.
    if (!("primary" in config.profile_scopes!.codex!.profiles![0].config)) {
      throw new Error("Expected Codex profile primary config.");
    }
    config.profile_scopes!.codex!.profiles![0].config.primary.key_strategy = "spread";

    const candidates = codexPrimaryCandidates(config);

    expect(candidates.map((candidate) => candidate.order)).toEqual([0, 0, 0]);
  });

  it("keeps orders monotonic when spread and fill_first profiles are mixed", () => {
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", [key("a1", "", "sk-a1"), key("a2", "", "sk-a2")]),
      pooledProfile("codex-b", "B", [key("b1", "", "sk-b1"), key("b2", "", "sk-b2")]),
      pooledProfile("codex-c", "C", [key("c1", "", "sk-c1")])
    ]);
    const profiles = config.profile_scopes!.codex!.profiles!;
    for (const profile of profiles) {
      if (!("primary" in profile.config)) {
        throw new Error("Expected Codex profile primary config.");
      }
    }
    // Only the middle profile spreads. Both strategies used to draw from
    // separate counters, so B's shared slot could collide with A's or C's keys
    // and blend two profiles' priority at 500 points per order step.
    (profiles[1].config as { primary: { key_strategy: PrimaryKeyStrategy } })
      .primary.key_strategy = "spread";

    const candidates = codexPrimaryCandidates(config);

    // A burns keys one at a time, B's two keys share one slot, C follows after.
    expect(candidates.map((candidate) => candidate.order)).toEqual([0, 1, 2, 2, 3]);
    expect(new Set(candidates.map((candidate) => candidate.order)).size).toBe(4);
  });
});

describe("primary key pool isolation", () => {
  it("quarantines one key without touching its siblings", () => {
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")])
    ]);
    const { state } = createState();

    // fill_first starts on k1; a single 401 quarantines it.
    recordRequests(state, config, 1, 401);

    const selection = state.preview(config, { model: "gpt-5.5" });
    expect(selection.profileId).toBe("codex-a");
    expect(selection.keyId).toBe("k2");
    expect(selection.candidateId).toBe("codex-a#k2");
  });

  it("sends the key each candidate was built for, not the pool's first", () => {
    const config = configWithKeyPool("codex-a", "Codex A", [
      key("key-1", "主号", "sk-first"),
      key("key-2", "备用", "sk-second"),
      key("key-3", "第三", "sk-third")
    ]);

    const candidates = codexPrimaryCandidates(config);

    // The assertion has to go through the resolver the request path uses.
    // `candidate.config.primary.api_key` was always correct; what shipped wrong
    // was that the pool sat beside it and `resolveRouteCredential` reads the
    // pool first, so all three candidates resolved to "sk-first".
    expect(candidates.map((candidate) => resolveRouteCredential("primary", candidate.config).apiKey))
      .toEqual(["sk-first", "sk-second", "sk-third"]);

    // Same resolver backs the signature, so a non-first key's value must move
    // its own candidate's signature and no one else's.
    const rotated = cloneConfig(config);
    apiKeyEntry(rotated, "key-2").api_key = "sk-second-rotated";
    const signatures = (source: CompactGateConfig) =>
      codexPrimaryCandidates(source).map((candidate) => candidateSignature([candidate]));
    const before = signatures(config);
    const after = signatures(rotated);
    expect(after.map((signature, index) => signature !== before[index])).toEqual([
      false,
      true,
      false
    ]);
  });

  it("lets a recovered key back into the draw despite a losing lifetime record", () => {
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")])
    ]);
    const primary = config.profile_scopes!.codex!.profiles![0].config;
    if (!("primary" in primary)) {
      throw new Error("Expected Codex profile primary config.");
    }
    // Spread gives both keys the same order, so `order * 500` cannot separate
    // them and health alone decides the draw — the only arrangement where the
    // lifetime error rate is what picks the winner.
    primary.primary.key_strategy = "spread";
    // k2 sits out the failure phase so every verdict lands on k1. Selecting
    // through `preview` each time would rotate to k2 as soon as k1's score dipped
    // and split the record across both keys, and reusing one held selection makes
    // each later success stale, which skips the streak reset that keeps k1 unblocked.
    primary.primary.api_keys![1].enabled = false;
    // A roll near 1 lands on the last candidate still inside TOP_K_SCORE_WINDOW,
    // which is precisely the question: is the recovered key eligible at all. The
    // usual `() => 0` always returns the leader, so it reports k2 whether k1 is
    // ranked second or exiled from the draw entirely.
    const state = new PrimaryFailoverState({ now: () => 0, random: () => 0.999 });

    // Ten transient failures then a success, twice. The threshold to cool a key
    // is eleven in a row, and each success resets the streak, so k1 finishes with
    // 20 of 22 attempts failed while every live counter reads zero and nothing
    // blocks it. Only the undecayable lifetime rate still holds anything against it.
    recordRequests(state, config, 10, 500);
    state.recordResult(selectAndReserve(state, config, { model: "gpt-5.5" }), 200, null);
    recordRequests(state, config, 10, 500);
    state.recordResult(selectAndReserve(state, config, { model: "gpt-5.5" }), 200, null);

    primary.primary.api_keys![1].enabled = true;

    // k1 is demonstrably alive: unblocked, no streaks, a success as its last word.
    // At the old 250-point weighting its ~91% lifetime rate alone sat it 227 below
    // its untouched sibling — past TOP_K_SCORE_WINDOW, so it was exiled from the
    // draw for good, since fresh successes can never outrun accumulated failures.
    // Capped at 60 the gap is 55, and the rate ranks k1 second instead of erasing it.
    expect(state.preview(config, { model: "gpt-5.5" }).keyId).toBe("k1");
  });

  it("forgets only the rotated key's health, not its siblings'", () => {
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")])
    ]);
    const { state } = createState();

    // Quarantine k1, then k2 which takes over its traffic.
    recordRequests(state, config, 1, 401);
    recordRequests(state, config, 1, 401);
    // Nothing eligible: the soonest-to-unblock fallback picks the first key.
    expect(state.preview(config, { model: "gpt-5.5" }).keyId).toBe("k1");

    // Rotate k1's credential value. Its own signature changes — the historical
    // whole-set-signature bug, retold one level down, would have cleared k2's
    // quarantine along with k1's.
    const rotated = cloneConfig(config);
    apiKeyEntry(rotated, "k1").api_key = "sk-rotated";
    expect(candidateSignature(codexPrimaryCandidates(rotated))).not.toBe(
      candidateSignature(codexPrimaryCandidates(config))
    );

    // k1 is forgotten and selectable again; k2's quarantine survives.
    expect(state.preview(rotated, { model: "gpt-5.5" }).keyId).toBe("k1");
    // k1 fails again, so nothing is eligible and the soonest-to-unblock fallback
    // runs. It must not hand the turn to k2, whose 401 still stands. This is the
    // assertion that separates the two implementations: while every candidate
    // hashed pool[0], rotating k1 cleared k2's quarantine too and k2 was picked
    // here.
    recordRequests(state, rotated, 1, 401);
    expect(state.preview(rotated, { model: "gpt-5.5" }).keyId).toBe("k1");
  });

  it("drops a deleted key cleanly and forgets only its pins", () => {
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")])
    ]);
    const { state } = createState();

    const bound = selectAndReserve(state, config, { sessionKey: "session-1", model: "gpt-5.5" });
    state.recordResult(bound, 200, null);
    expect(state.boundProfileId({ sessionKey: "session-1" })).toBe("codex-a#k1");

    const withoutKey = cloneConfig(config);
    poolOf(withoutKey).splice(0, 1);
    const selection = state.preview(withoutKey, { model: "gpt-5.5" });

    expect(selection.keyId).toBe("k2");
    // The pin pointed at the deleted composite id and is gone; the sticky
    // lookup for the session now returns nothing rather than a dead id.
    expect(state.boundProfileId({ sessionKey: "session-1" })).toBeNull();
  });
});

describe("sticky-only three-zone admission", () => {
  it("stops taking new sessions after a 429 until a success clears the reserve", () => {
    const config = configWithCodexProfiles([
      withReserve(pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")]), 300)
    ]);
    const clock = createClock(1_000);

    // Bind s1 to k1 with a success first, so it has a real claim on the key.
    const first = selectAndReserve(clock.state, config, { model: "gpt-5.5", sessionKey: "s1" });
    expect(first.keyId).toBe("k1");
    clock.state.recordResult(first, 200, null);

    // k1 hits the cap: cooldown 2s, then a 300s sticky-only reserve.
    clock.state.recordResult(
      selectAndReserve(clock.state, config, { model: "gpt-5.5" }),
      { status: 429, errorSummary: "rate limit", responseHeaders: { "retry-after": "2" } }
    );
    expect(clock.state.preview(config, { model: "gpt-5.5" }).keyId).toBe("k2");

    // A session binds k2 while k1 cools; when the cooldown expires the session
    // already on k2 stays, and a NEW session is still turned away from k1.
    const bound = selectAndReserve(clock.state, config, { model: "gpt-5.5", sessionKey: "s2" });
    expect(bound.keyId).toBe("k2");
    clock.state.recordResult(bound, 200, null);

    clock.advance(2_100);
    // Cooldown expired — but k1 is sticky-only for its reserve, so fresh
    // traffic still goes to k2...
    expect(clock.state.preview(config, { model: "gpt-5.5", sessionKey: "s2" }).keyId).toBe("k2");
    expect(clock.state.preview(config, { model: "gpt-5.5", sessionKey: "fresh" }).keyId).toBe("k2");

    // ...while the session k1 served before the 429 stays on k1.
    const old = selectAndReserve(clock.state, config, { model: "gpt-5.5", sessionKey: "s1" });
    expect(old.keyId).toBe("k1");
    clock.state.recordResult(old, 200, null);

    // The success proves the cap is clear: k1 takes new sessions again.
    expect(clock.state.preview(config, { model: "gpt-5.5", sessionKey: "fresh-2" }).keyId).toBe("k1");
  });

  it("makes a sticky-only key the last resort for new sessions", () => {
    const config = configWithCodexProfiles([
      withReserve(pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")]), 300)
    ]);
    const clock = createClock(1_000);

    // Both keys hit the cap; both are cooling, then sticky-only.
    clock.state.recordResult(
      selectAndReserve(clock.state, config, { model: "gpt-5.5" }),
      { status: 429, errorSummary: "rate limit", responseHeaders: { "retry-after": "2" } }
    );
    clock.state.recordResult(
      selectAndReserve(clock.state, config, { model: "gpt-5.5" }),
      { status: 429, errorSummary: "rate limit", responseHeaders: { "retry-after": "2" } }
    );
    clock.advance(2_100);

    // Nobody takes new sessions; the flood-back lands on the sticky-only key
    // (deadline 0) rather than failing the request.
    expect(clock.state.preview(config, { model: "gpt-5.5", sessionKey: "fresh" }).keyId).toBe("k1");
  });
});

describe("rotation opt-out", () => {
  it("keeps an opted-out profile out of automatic rotation but reachable manually", () => {
    const oauth = codexProfile("codex-oauth", "OAuth", "http://127.0.0.1:9101/v1", "sk-oauth");
    if (!("primary" in oauth.config)) {
      throw new Error("Expected Codex profile primary config.");
    }
    oauth.config.primary.rotation_opt_out = true;
    const config = configWithCodexProfiles([
      oauth,
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "sk-b")
    ]);
    const { state } = createState();

    // Automatic rotation never selects the bound account.
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");

    // Manual force still works — the operator chose it.
    state.forceNextProfileSelection(config, "codex-oauth");
    expect(selectAndReserve(state, config, { model: "gpt-5.5" }).profileId).toBe("codex-oauth");
  });
});

describe("sticky escape keeps the binding", () => {
  it("falls through during a cooldown and returns to the bound key after it", () => {
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")])
    ]);
    const clock = createClock(1_000);

    // Bind the session to k1 with a success.
    const bound = selectAndReserve(clock.state, config, { sessionKey: "s1", model: "gpt-5.5" });
    expect(bound.keyId).toBe("k1");
    clock.state.recordResult(bound, 200, null);

    // k1 gets rate-limited; the same session is served by k2 while it cools.
    clock.state.recordResult(
      selectAndReserve(clock.state, config, { sessionKey: "s9", model: "gpt-5.5" }),
      { status: 429, errorSummary: "rate limit", responseHeaders: { "retry-after": "2" } }
    );
    expect(clock.state.preview(config, { sessionKey: "s1", model: "gpt-5.5" }).keyId).toBe("k2");

    // The binding survives the fall-through — after the cooldown the session
    // lands back on k1 without ever having been deleted (the CLIProxyAPI #4989
    // class of bug: a late failure deleting a rebound pin).
    clock.advance(2_100);
    expect(clock.state.preview(config, { sessionKey: "s1", model: "gpt-5.5" }).keyId).toBe("k1");
  });
});

describe("key pool state domains", () => {
  it("scopes the default domain per key, keeping single-key domains stable", () => {
    const primary = { ...DEFAULT_CONFIG.primary, base_url: "https://api.example.test/v1" };

    expect(stateDomainForPrimary(primary, "codex-a")).toBe("profile:codex-a:https://api.example.test");
    expect(stateDomainForPrimary(primary, "codex-a", "k1")).toBe(
      "profile:codex-a#k1:https://api.example.test"
    );
  });

  it("still honours an explicit state_domain_id over the per-key default", () => {
    const primary = {
      ...DEFAULT_CONFIG.primary,
      base_url: "https://api.example.test/v1",
      state_domain_id: "shared-account"
    };

    expect(stateDomainForPrimary(primary, "codex-a", "k1")).toBe("shared-account");
  });

  it("resolves a pooled profile through its first key", () => {
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", [key("k1", "", "sk-1"), key("k2", "", "sk-2")])
    ]);

    expect(stateDomainForProfile(config, "codex-a")).toBe("profile:codex-a#k1:https://api.example.test");
  });
});

describe("key pool credential resolution", () => {
  it("serves the first enabled key outside the scheduler", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.primary.api_keys = [
      disabledKey("k1", "停用", "sk-disabled"),
      key("k2", "", "sk-active")
    ];

    const credential = resolveRouteCredential("primary", config);

    expect(credential.apiKey).toBe("sk-active");
    expect(credential.apiKeySource).toBe("config");
  });

  it("falls back to the single api_key when the pool is empty", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.primary.api_key = "sk-single";
    config.primary.api_keys = [disabledKey("k1", "停用", "sk-disabled")];

    expect(resolveRouteCredential("primary", config).apiKey).toBe("sk-single");
  });
});

describe("key pool config merge and validation", () => {
  it("inherits an omitted api_key from the baseline entry with the same id", () => {
    const base = cloneConfig(DEFAULT_CONFIG);
    base.primary.api_keys = [key("k1", "主号", "sk-stored"), key("k2", "备用", "sk-kept")];

    const merged = mergeRuntimeConfig(base, {
      primary: {
        api_keys: [
          // Rename only: the stored secret must survive.
          { id: "k1", label: "改名的主号" },
          { id: "k2", label: "备用", api_key: "sk-replaced" },
          { id: "k3", label: "新钥匙", api_key: "sk-new" }
        ]
      }
    });

    expect(merged.primary.api_keys).toEqual([
      { id: "k1", label: "改名的主号", api_key: "sk-stored", enabled: true },
      { id: "k2", label: "备用", api_key: "sk-replaced", enabled: true },
      { id: "k3", label: "新钥匙", api_key: "sk-new", enabled: true }
    ]);
  });

  it("keeps the pool when the patch omits api_keys and clears it on an explicit empty array", () => {
    const base = cloneConfig(DEFAULT_CONFIG);
    base.primary.api_keys = [key("k1", "", "sk-stored")];

    expect(mergeRuntimeConfig(base, { primary: { base_url: base.primary.base_url } })
      .primary.api_keys).toEqual([key("k1", "", "sk-stored")]);
    expect(mergeRuntimeConfig(base, { primary: { api_keys: [] } })
      .primary.api_keys).toBeUndefined();
  });

  it("rejects duplicate and blank key ids", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.primary.api_keys = [key("k1", "", "sk-1"), key("k1", "", "sk-2")];
    expect(() => validateRuntimeConfig(config)).toThrow("duplicate key id: k1");

    const blank = cloneConfig(DEFAULT_CONFIG);
    blank.primary.api_keys = [key(" ", "", "sk-1")];
    expect(() => validateRuntimeConfig(blank)).toThrow("must be a non-empty string");
  });

  it("rejects an oversized pool and an unknown key strategy", () => {
    const oversized = cloneConfig(DEFAULT_CONFIG);
    oversized.primary.api_keys = Array.from({ length: 17 }, (_, index) =>
      key(`k${index}`, "", `sk-${index}`)
    );
    expect(() => validateRuntimeConfig(oversized)).toThrow("at most 16");

    const badStrategy = cloneConfig(DEFAULT_CONFIG);
    badStrategy.primary.key_strategy = "round_robin" as PrimaryKeyStrategy;
    expect(() => validateRuntimeConfig(badStrategy)).toThrow("fill_first or spread");
  });

  it("defaults the strategy to fill_first and accepts spread through the merge", () => {
    expect(mergeRuntimeConfig(DEFAULT_CONFIG, {}).primary.key_strategy).toBe("fill_first");
    expect(mergeRuntimeConfig(DEFAULT_CONFIG, { primary: { key_strategy: "spread" } })
      .primary.key_strategy).toBe("spread");
  });
});

function key(id: string, label: string, apiKey: string): UpstreamApiKey {
  return { id, label, api_key: apiKey, enabled: true };
}

function disabledKey(id: string, label: string, apiKey: string): UpstreamApiKey {
  return { id, label, api_key: apiKey, enabled: false };
}

function pooledProfile(
  id: string,
  name: string,
  apiKeys: UpstreamApiKey[]
): SavedConfigProfile {
  const profile = codexProfile(id, name, "https://api.example.test/v1");
  if (!("primary" in profile.config)) {
    throw new Error("Expected Codex profile primary config.");
  }
  profile.config.primary.api_keys = apiKeys;
  return profile;
}

function poolOf(config: CompactGateConfig): UpstreamApiKey[] {
  const profile = config.profile_scopes?.codex?.profiles?.[0];
  if (!profile || !("primary" in profile.config)) {
    throw new Error("Expected pooled Codex profile.");
  }
  return profile.config.primary.api_keys ?? [];
}

function apiKeyEntry(config: CompactGateConfig, id: string): UpstreamApiKey {
  const entry = poolOf(config).find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Expected key pool entry ${id}.`);
  }
  return entry;
}


function configWithKeyPool(id: string, name: string, apiKeys: UpstreamApiKey[]): CompactGateConfig {
  return configWithCodexProfiles([pooledProfile(id, name, apiKeys)]);
}

function selectAndReserve(
  state: PrimaryFailoverState,
  config: CompactGateConfig,
  context: { model?: string; sessionKey?: string } = {}
) {
  const selection = state.preview(config, context);
  state.reserveSelection(selection, config.primary_failover.auto_schedule);
  return selection;
}

function recordRequests(
  state: PrimaryFailoverState,
  config: CompactGateConfig,
  count: number,
  status: number
): void {
  for (let index = 0; index < count; index += 1) {
    state.recordResult(selectAndReserve(state, config, { model: "gpt-5.5" }), status, AUTH_ERROR);
  }
}

function createState(): { state: PrimaryFailoverState } {
  return { state: new PrimaryFailoverState({ now: () => 0, random: () => 0 }) };
}

function createClock(startNow = 0): { state: PrimaryFailoverState; advance: (ms: number) => void } {
  let now = startNow;
  return {
    state: new PrimaryFailoverState({ now: () => now, random: () => 0 }),
    advance: (ms: number) => {
      now += ms;
    }
  };
}

function withReserve(
  profile: SavedConfigProfile,
  reserveSeconds: number
): SavedConfigProfile {
  if (!("primary" in profile.config)) {
    throw new Error("Expected Codex profile primary config.");
  }
  profile.config.primary.sticky_reserve_seconds = reserveSeconds;
  return profile;
}


function codexProfile(
  id: string,
  name: string,
  primaryBaseUrl: string,
  primaryApiKey = DEFAULT_CONFIG.primary.api_key
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
        api_key: primaryApiKey
      },
      compact: { ...DEFAULT_CONFIG.compact }
    }
  };
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

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return structuredClone(config);
}
