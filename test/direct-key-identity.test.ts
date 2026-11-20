import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { codexPrimaryCandidates } from "../src/server/primary-failover-candidates.js";
import { stateDomainForPrimary } from "../src/server/provider-state-domain.js";
import type { CompactGateConfig, PrimaryUpstreamConfig } from "../src/shared/types.js";

function fixture() {
  const config: CompactGateConfig = structuredClone(DEFAULT_CONFIG);
  const primary: PrimaryUpstreamConfig = { ...config.primary, api_key: "synthetic-direct", api_key_env: "", base_url: "https://synthetic.example/v1" };
  config.primary = primary;
  config.primary_failover.auto_schedule = true;
  config.profile_scopes = { ...config.profile_scopes, codex: {
    active_profile_id: "a", profiles: [
      { id: "a", name: "A", created_at: "", updated_at: "", config: { primary, compact: config.compact } },
      { id: "b", name: "B", created_at: "", updated_at: "", config: { primary: { ...primary, api_key: "synthetic-other" }, compact: config.compact } }
    ]
  } };
  return { config, primary, state: new PrimaryFailoverState({ now: () => 1000, random: () => 0 }) };
}

it("does not re-admit the unchanged direct key when adding its first backup", () => {
  const { config, primary, state } = fixture();
  const initial = state.preview(config, { sessionKey: "synthetic-session" });
  state.reserveSelection(initial, true);
  state.recordResult(initial, { status: 401, errorSummary: "Invalid API key" });
  expect(state.preview(config).profileId).toBe("b");

  primary.api_keys = [{ id: "backup", label: "backup", api_key: "synthetic-backup", enabled: true }];
  const selected = state.preview(config);
  expect(selected.config.primary.api_key).toBe("synthetic-backup");
});

it("keeps the existing direct credential domain and session binding when adding a backup", () => {
  const { config, primary, state } = fixture();
  const initial = state.preview(config, { sessionKey: "synthetic-session" });
  state.reserveSelection(initial, true);
  state.recordResult(initial, { status: 200, errorSummary: null, responseId: "resp_synthetic" });
  const originalDomain = stateDomainForPrimary(initial.config.primary, initial.profileId, initial.keyId);
  primary.api_keys = [{ id: "backup", label: "backup", api_key: "synthetic-backup", enabled: true }];
  state.preview(config);
  const current = codexPrimaryCandidates(config).find(candidate => candidate.primary.api_key === "synthetic-direct")!;
  expect.soft(stateDomainForPrimary(current.primary, current.profileId, current.keyId)).toBe(originalDomain);
  expect.soft(state.boundProfileId({ previousResponseId: "resp_synthetic" })).toBe(current.id);
});

it("does not re-admit the unchanged direct key when removing its last backup", () => {
  const { config, primary, state } = fixture();
  primary.api_keys = [{ id: "backup", label: "backup", api_key: "synthetic-backup", enabled: true }];
  const initial = state.preview(config);
  state.reserveSelection(initial, true);
  state.recordResult(initial, { status: 401, errorSummary: "Invalid API key" });
  expect(state.preview(config).keyId).toBe("backup");
  primary.api_keys = [];
  expect(state.preview(config).profileId).toBe("b");
});
