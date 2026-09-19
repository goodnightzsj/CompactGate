import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import type { CompactGateConfig, SavedConfigProfile, UpstreamApiKey } from "../src/shared/types.js";

/**
 * A 401 on one key of a pooled profile must first move to that profile's sibling
 * key; the profile is only left once its own keys are exhausted.
 *
 * Rebuilt from synthetic fixtures. The probe this replaces copied a developer's
 * real compactgate.json, so it could neither run for anyone else nor fail when
 * the behaviour broke — its only assertion was `expect(true).toBe(true)`.
 */
function key(id: string, label: string, apiKey: string): UpstreamApiKey {
  return { id, label, api_key: apiKey, enabled: true };
}

function pooledProfile(id: string, name: string, apiKeys: UpstreamApiKey[]): SavedConfigProfile {
  return {
    id,
    name,
    created_at: "2026-06-06T00:00:00.000Z",
    updated_at: "2026-06-06T00:00:00.000Z",
    config: {
      primary: { ...DEFAULT_CONFIG.primary, base_url: "https://api.example.test/v1", api_keys: apiKeys },
      compact: { ...DEFAULT_CONFIG.compact }
    }
  };
}

function configWithPool(): CompactGateConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    profile_scopes: {
      codex: {
        profiles: [
          pooledProfile("codex-demo", "Demo", [
            key("key-1", "primary", "sk-synthetic-1"),
            key("key-2", "backup", "sk-synthetic-2")
          ]),
          pooledProfile("codex-other", "Other", [key("key-3", "other", "sk-synthetic-3")])
        ],
        active_profile_id: "codex-demo"
      },
      claude: { profiles: [], active_profile_id: null }
    }
  };
}

/** `profileName` is rendered as "<profile> · <key>" for pooled selections. */
function profileOf(profileName: string): string {
  return profileName.split(" · ")[0];
}

function selectAndFail(state: PrimaryFailoverState, config: CompactGateConfig, index: number) {
  const selection = state.preview(config, {
    sessionKey: `s${index}`,
    model: "gpt-6-astra",
    headers: {}
  } as never);
  state.recordResult(selection, { status: 401, retryable: false, nowMs: index * 1000 } as never);
  return selection;
}

describe("primary key pool inside one active profile", () => {
  it("moves to the sibling key first, and only leaves the profile once its keys are exhausted", () => {
    expect(DEFAULT_CONFIG.primary_failover.auto_schedule).toBe(true);

    const config = configWithPool();
    const state = new PrimaryFailoverState();

    const first = selectAndFail(state, config, 0);
    const second = selectAndFail(state, config, 1);
    const third = selectAndFail(state, config, 2);

    // The failing key's sibling carries the retry, inside the same profile.
    expect(profileOf(first.profileName)).toBe("Demo");
    expect(profileOf(second.profileName)).toBe("Demo");
    expect(first.keyLabel).toBe("primary");
    expect(second.keyLabel).toBe("backup");

    // Only after both keys of the active profile have failed does it leave.
    expect(profileOf(third.profileName)).toBe("Other");
  });

  it("keeps both keys of the active profile as candidates", () => {
    const config = configWithPool();
    const pool = config.profile_scopes?.codex?.profiles?.[0];
    if (!pool || !("primary" in pool.config)) {
      throw new Error("Expected a pooled Codex profile.");
    }
    const enabled = (pool.config.primary.api_keys ?? []).filter((entry) => entry.enabled);
    expect(enabled.map((entry) => entry.label)).toEqual(["primary", "backup"]);
  });
});
