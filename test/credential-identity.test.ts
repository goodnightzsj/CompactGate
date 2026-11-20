import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import { ClaudeKeyPoolState } from "../src/server/claude-key-pool.js";
import { codexPrimaryCandidates, candidateSignatures } from "../src/server/primary-failover-candidates.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { hashStateDomain, stateDomainForPrimary } from "../src/server/provider-state-domain.js";
import type { CompactGateConfig, SavedConfigProfile } from "../src/shared/types.js";

function pooled(profileId: string, keyId: string): SavedConfigProfile {
  return { id: profileId, name: profileId, created_at: "", updated_at: "", config: {
    primary: { ...DEFAULT_CONFIG.primary, api_key: "", api_keys: [{ id: keyId, label: "", enabled: true, api_key: "synthetic-key" }] },
    compact: { ...DEFAULT_CONFIG.compact }
  } };
}
function claude(keyId: string): CompactGateConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.claude.primary.api_key = "";
  config.claude.primary.api_keys = [keyId, "backup"].map(id => ({ id, label: "", enabled: true, api_key: `synthetic-${id}` }));
  return config;
}

describe("credential identity isolation", () => {
  it("separates colliding pooled and direct candidates without changing public IDs", () => {
    const direct = pooled("a#b#c", "unused");
    if (!("primary" in direct.config)) throw new Error("Expected primary");
    direct.config.primary.api_keys = [];
    direct.config.primary.api_key = "synthetic-direct";
    const profiles = [pooled("a", "b#c"), pooled("a#b", "c"), direct];
    const config = { ...structuredClone(DEFAULT_CONFIG), profile_scopes: { codex: { profiles, active_profile_id: "a" } } };
    const candidates = codexPrimaryCandidates(config);
    expect(new Set(candidates.map(candidate => candidate.id)).size).toBe(3);
    expect(candidateSignatures(candidates).size).toBe(3);
    expect(candidates.map(candidate => candidate.profileId)).toEqual(["a", "a#b", "a#b#c"]);
    const state = new PrimaryFailoverState({ now: () => 1000, random: () => 0 });
    const selected = state.preview(config, { sessionKey: "synthetic-session" });
    state.reserveSelection(selected, true);
    state.recordResult(selected, 401, "Upstream returned HTTP 401: invalid token.");
    expect(state.preview(config, { sessionKey: "synthetic-session" }).profileId).toBe("a#b");
  });

  it.each([["a", "b#c", "a#b", "c"], [null, "c", "null", "c"]] as const)(
    "does not share Claude quarantine or pins between %s/%s and %s/%s", (leftProfile, leftKey, rightProfile, rightKey) => {
      const state = new ClaudeKeyPoolState({ now: () => 1000, random: () => 0 });
      const headers = { "x-claude-code-session-id": "synthetic-session" };
      const left = claude(leftKey), right = claude(rightKey);
      state.recordResult(state.select(left, leftProfile, headers), { status: 401, responseHeaders: {} });
      expect(state.select(left, leftProfile, headers)?.keyId).toBe("backup");
      expect(state.select(right, rightProfile, headers)?.keyId).toBe(rightKey);
      const rightSelected = state.select(right, rightProfile, headers);
      state.recordResult(rightSelected, { status: 200, responseHeaders: {} });
      expect(state.select(left, leftProfile, headers)?.keyId).toBe("backup");
    }
  );

  it("keeps state domains injective, including escaped punctuation and UTF-16 edge cases", () => {
    const ids = ["plain-id", "null", "a", "a#b", "b#c", "c", "a:b", "%0023", "%", "#", "\ud800", "\ud801", "\ufffd", "中文"];
    const domains = ids.flatMap(profile => [stateDomainForPrimary(DEFAULT_CONFIG.primary, profile),
      ...ids.map(key => stateDomainForPrimary(DEFAULT_CONFIG.primary, profile, key))]);
    expect(new Set(domains).size).toBe(domains.length);
    expect(new Set(domains.map(hashStateDomain)).size).toBe(domains.length);
    expect(stateDomainForPrimary({ ...DEFAULT_CONFIG.primary, base_url: "https://api.example.test/v1" }, "ordinary-id", "key_1"))
      .toBe("profile:ordinary-id#key_1:https://api.example.test");
  });
});
