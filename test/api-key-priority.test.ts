import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, DEFAULT_CONFIG } from "../src/server/config.js";
import { reScopeProfileConfig } from "../src/server/config-profile-scope.js";
import { enabledApiKeyPool, DIRECT_API_KEY_ID, resolveRouteCredential } from "../src/server/credentials.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { candidateSignatures, codexPrimaryCandidates } from "../src/server/primary-failover-candidates.js";
import { ClaudeKeyPoolState } from "../src/server/claude-key-pool.js";
import type { CompactGateConfig, PrimaryKeyStrategy } from "../src/shared/types.js";
import {
  applyDraftToConfigExport, changedConfigAreas, formAfterScopedProfileChange,
  formFromConfig, formToPatch, isFormDirty
} from "../src/ui/config/config-form-state.js";
import { INITIAL_STUDIO_CONFIG_STATE, reduceStudioConfigState } from "../src/ui/config/studio-config-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("API key priority configuration", () => {
  it("keeps legacy storage unchanged and round-trips priorities without losing secrets", async () => {
    const dir = await makeConfigDir();
    const configPath = path.join(dir, "compactgate.json");
    const store = await ConfigStore.load(configPath);
    expect(store.get().primary).not.toHaveProperty("api_key_priority");
    await store.patch({
      primary: {
        api_key: "sk-synthetic-direct",
        api_key_priority: 10,
        api_keys: [
          { id: "first", label: "Primary", api_key: "sk-synthetic-first", enabled: true, priority: 30 },
          { id: "second", label: "Spare", api_key: "sk-synthetic-second", enabled: false, priority: 5 }
        ]
      }
    });
    await store.patch({ primary: { api_keys: [{ id: "second" }, { id: "first", label: "Renamed" }] } });
    expect(store.get().primary).toMatchObject({ api_key_priority: 10, api_keys: [
      { id: "second", priority: 5, api_key: "sk-synthetic-second", enabled: false },
      { id: "first", priority: 30, api_key: "sk-synthetic-first", label: "Renamed" }
    ] });
    const publicConfig = store.toPublicConfig();
    expect(publicConfig.primary).toMatchObject({ api_key_priority: 10, api_keys: [
      { id: "second", priority: 5 }, { id: "first", priority: 30 }
    ] });
    expect(JSON.stringify(publicConfig)).not.toContain("sk-synthetic-");
    const copied = reScopeProfileConfig({ primary: store.get().primary, compact: store.get().compact }, "codex", "claude");
    expect(copied).toMatchObject({ claude: { primary: { api_key_priority: 10, api_keys: [
      { id: "second", priority: 5, api_key: "sk-synthetic-second" },
      { id: "first", priority: 30, api_key: "sk-synthetic-first" }
    ] } } });
    const reopened = await ConfigStore.load(configPath);
    expect(reopened.get().primary).toEqual(store.get().primary);
    const imported = await ConfigStore.load(path.join(dir, "imported.json"));
    await imported.importConfig(store.get());
    expect(imported.get().primary).toEqual(store.get().primary);
    await store.patch({ primary: { api_key_priority: 0, api_keys: [{ id: "first", priority: 0 }] } });
    expect(store.get().primary).toMatchObject({ api_key_priority: 0, api_keys: [{ id: "first", priority: 0, api_key: "sk-synthetic-first" }] });
  });

  it.each([null, "10", -1, 101, 0.5, Number.NaN, Number.POSITIVE_INFINITY, true])("rejects invalid priority %s without changing config", async (priority) => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const revision = store.revision;
    for (const primary of [
      { api_key_priority: priority },
      { api_keys: [{ id: "key", api_key: "sk-synthetic-value", priority }] }
    ]) {
      await expect(store.patch({ primary })).rejects.toThrow(/priority.*integer between 0 and 100/);
      await expect(store.patch({ claude: { primary } })).rejects.toThrow(/priority.*integer between 0 and 100/);
    }
    expect(store.revision).toBe(revision);
  });
});

describe("API key priority selection", () => {
  it("orders direct and additional keys stably without mutating stored entries", () => {
    const config = priorityConfig();
    const before = structuredClone(config.primary.api_keys);
    expect(enabledApiKeyPool(config.primary).map((key) => key.id)).toEqual(["preferred", DIRECT_API_KEY_ID, "fallback"]);
    expect(config.primary.api_keys).toEqual(before);
    expect(resolveRouteCredential("primary", config).apiKey).toBe("sk-synthetic-preferred");
    config.primary_failover.auto_schedule = false;
    expect(new PrimaryFailoverState().preview(config).keyId).toBe("preferred");
    config.primary.api_key_priority = 100;
    expect(new PrimaryFailoverState().preview(config).keyId).toBe(DIRECT_API_KEY_ID);
  });

  it.each(["fill_first", "spread"] as const)("uses highest eligible priority then falls back in both schedulers (%s)", (strategy) => {
    const config = priorityConfig(strategy);
    const codex = new PrimaryFailoverState({ now: () => 0, random: () => 0 });
    const selected = codex.preview(config, { sessionKey: "new" });
    expect(selected.keyId).toBe("preferred");
    expect(resolveRouteCredential("primary", selected.config).apiKey).toBe("sk-synthetic-preferred");
    codex.reserveSelection(selected, true);
    codex.recordResult(selected, 401, "invalid key");
    expect(codex.preview(config, { sessionKey: "next" }).keyId).toBe(DIRECT_API_KEY_ID);
    const claude = new ClaudeKeyPoolState({ now: () => 0, random: () => 0 });
    expect(claude.select(config, "main", {})?.keyId).toBe("preferred");
    claude.recordResult(claude.select(config, "main", {}), { status: 401, responseHeaders: {} });
    expect(claude.select(config, "main", {})?.keyId).toBe(DIRECT_API_KEY_ID);
  });

  it("spreads only within the highest eligible tier", () => {
    const config = priorityConfig("spread");
    const peer = { id: "peer", label: "Peer", api_key: "sk-synthetic-peer", enabled: true, priority: 10 };
    config.primary.api_keys!.push(peer);
    config.claude.primary.api_keys!.push({ ...peer });
    const codexPicks = new Set<string | null>();
    const claudePicks = new Set<string | undefined>();
    for (const roll of [0, 0.25, 0.75, 0.99]) {
      codexPicks.add(new PrimaryFailoverState({ now: () => 0, random: () => roll }).preview(config).keyId);
      claudePicks.add(new ClaudeKeyPoolState({ now: () => 0, random: () => roll }).select(config, "main", {})?.keyId);
    }
    expect(codexPicks).toEqual(new Set(["preferred", "peer"]));
    expect(claudePicks).toEqual(new Set(["preferred", "peer"]));
  });

  it("does not turn priority into a score bonus that concurrent load can outweigh", () => {
    const config = priorityConfig("spread");
    const state = new PrimaryFailoverState({ now: () => 0, random: () => 0.99 });
    for (let index = 0; index < 30; index += 1) {
      const selection = state.preview(config, { sessionKey: `request-${index}` });
      expect(selection.keyId).toBe("preferred");
      state.reserveSelection(selection, true);
    }
  });

  it("admits lower tiers during sticky reserve and restores priority after recovery", () => {
    const config = priorityConfig();
    config.primary.sticky_reserve_seconds = 60;
    config.claude.primary.sticky_reserve_seconds = 60;
    let now = 1_000;
    const codex = new PrimaryFailoverState({ now: () => now, random: () => 0 });
    const claude = new ClaudeKeyPoolState({ now: () => now, random: () => 0 });
    const headers = { "x-session-id": "old" };
    const success = codex.preview(config, { sessionKey: "old" });
    codex.reserveSelection(success, true);
    codex.recordResult(success, 200);
    claude.select(config, "main", headers);
    claude.recordResult(claude.select(config, "main", headers), { status: 200, responseHeaders: {} });
    const limited = codex.preview(config, { sessionKey: "old" });
    codex.reserveSelection(limited, true);
    const rateLimit = { status: 429, errorSummary: "rate limited", responseHeaders: { "retry-after": "1" } };
    codex.recordResult(limited, rateLimit);
    claude.recordResult(claude.select(config, "main", headers), rateLimit);
    now += 1_001;
    expect(codex.preview(config, { sessionKey: "new" }).keyId).toBe(DIRECT_API_KEY_ID);
    expect(claude.select(config, "main", {})?.keyId).toBe(DIRECT_API_KEY_ID);
    const recovered = codex.preview(config, { sessionKey: "old" });
    expect(recovered.keyId).toBe("preferred");
    expect(claude.select(config, "main", headers)?.keyId).toBe("preferred");
    codex.reserveSelection(recovered, true);
    codex.recordResult(recovered, 200);
    claude.recordResult(claude.select(config, "main", headers), { status: 200, responseHeaders: {} });
    expect(codex.preview(config, { sessionKey: "new" }).keyId).toBe("preferred");
    expect(claude.select(config, "main", {})?.keyId).toBe("preferred");
  });

  it("keeps soonest-unblock fallback when all priority tiers are blocked", () => {
    const config = priorityConfig();
    const codex = new PrimaryFailoverState({ now: () => 1_000, random: () => 0 });
    const claude = new ClaudeKeyPoolState({ now: () => 1_000, random: () => 0 });
    for (const [keyId, seconds] of [["preferred", "120"], [DIRECT_API_KEY_ID, "60"], ["fallback", "1"]]) {
      const selection = codex.preview(config);
      expect(selection.keyId).toBe(keyId);
      expect(claude.select(config, "main", {})?.keyId).toBe(keyId);
      const result = { status: 429, errorSummary: "rate limited", responseHeaders: { "retry-after": seconds } };
      codex.reserveSelection(selection, true);
      codex.recordResult(selection, result);
      claude.recordResult(claude.select(config, "main", {}), result);
    }
    expect(codex.preview(config).keyId).toBe("fallback");
    expect(claude.select(config, "main", {})?.keyId).toBe("fallback");
  });

  it("preserves signatures, old session affinity, quarantine and in-flight attribution after editing priorities", () => {
    const config = priorityConfig();
    const state = new PrimaryFailoverState({ now: () => 0, random: () => 0 });
    const first = state.preview(config, { sessionKey: "old" });
    state.reserveSelection(first, true);
    state.recordResult(first, 200);
    const inFlight = state.preview(config, { sessionKey: "inflight" });
    state.reserveSelection(inFlight, true);
    const signatures = candidateSignatures(codexPrimaryCandidates(config));
    config.primary.api_keys![0].priority = 50;
    config.primary.api_keys!.reverse();
    expect(candidateSignatures(codexPrimaryCandidates(config))).toEqual(signatures);
    expect(state.preview(config, { sessionKey: "old" }).keyId).toBe("preferred");
    const next = state.preview(config, { sessionKey: "new" });
    expect(next.keyId).toBe("fallback");
    expect(next.generation).toBe(first.generation);
    state.recordResult(inFlight, 401, "invalid key");
    config.primary.api_keys!.find((entry) => entry.id === "preferred")!.priority = 90;
    expect(state.preview(config, { sessionKey: "old" }).keyId).toBe("fallback");
  });

  it("preserves Claude session affinity and health while promoting another key", () => {
    const config = priorityConfig();
    const state = new ClaudeKeyPoolState({ now: () => 0, random: () => 0 });
    const headers = { "x-session-id": "old" };
    expect(state.select(config, "main", headers)?.keyId).toBe("preferred");
    state.recordResult(state.select(config, "main", headers), { status: 200, responseHeaders: {} });
    config.claude.primary.api_keys![0].priority = 50;
    expect(state.select(config, "main", headers)?.keyId).toBe("preferred");
    expect(state.select(config, "main", { "x-session-id": "new" })?.keyId).toBe("fallback");
    state.recordResult(state.select(config, "main", headers), { status: 401, responseHeaders: {} });
    config.claude.primary.api_keys![1].priority = 90;
    expect(state.select(config, "main", headers)?.keyId).toBe("fallback");
  });

  it("does not promote another profile just because its key priority is larger", () => {
    const config = priorityConfig("spread");
    const profiles = config.profile_scopes!.codex!.profiles!;
    const other = structuredClone(profiles[0]);
    other.id = "other";
    if (!("primary" in other.config)) throw new Error("Expected a Codex profile.");
    other.config.primary.api_key_priority = 100;
    other.config.primary.api_keys = [];
    profiles.push(other);
    expect(new PrimaryFailoverState({ now: () => 0, random: () => 0.99 }).preview(config).profileId).toBe("main");
  });

  it("does not inherit the active profile's priority for a legacy direct key", () => {
    const config = priorityConfig("spread");
    const profiles = config.profile_scopes!.codex!.profiles!;
    const legacy = structuredClone(profiles[0]);
    legacy.id = "legacy";
    legacy.name = "Legacy";
    if (!("primary" in legacy.config)) throw new Error("Expected a Codex profile.");
    delete legacy.config.primary.api_key_priority;
    profiles.push(legacy);
    config.primary.api_key_priority = 100;
    const state = new PrimaryFailoverState({ now: () => 0, random: () => 0 });
    for (const keyId of [DIRECT_API_KEY_ID, "preferred", "fallback"]) {
      const selection = state.preview(config);
      expect(selection.profileId).toBe("main");
      expect(selection.keyId).toBe(keyId);
      state.reserveSelection(selection, true);
      state.recordResult(selection, 401, "invalid key");
    }
    const selection = state.preview(config);
    expect(selection.profileId).toBe("legacy");
    expect(selection.keyId).toBe("preferred");
    expect(selection.config.primary.api_key_priority ?? 0).toBe(0);
  });
});

describe("API key priority form round trips", () => {
  it.each(["codex", "claude"] as const)("preserves %s priorities, secrets and scoped drafts across save and export", async (scope) => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = priorityConfig();
    await store.patch({ primary: config.primary, claude: config.claude });
    const baseline = store.toPublicConfig();
    const form = formFromConfig(baseline);
    const prefix = scope === "codex" ? "codexPrimary" : "claudePrimary";
    const otherPrefix = scope === "codex" ? "claudePrimary" : "codexPrimary";
    expect(form[`${prefix}ApiKeyPriority`]).toBe(0);
    expect(form[`${prefix}ApiKeys`][1].priority).toBe(10);
    expect(isFormDirty(baseline, form)).toBe(false);
    const draft = { ...form, [`${prefix}ApiKeyPriority`]: 40 };
    draft[`${prefix}ApiKeys`] = form[`${prefix}ApiKeys`].map((entry, index) => ({ ...entry, priority: index === 0 ? 80 : entry.priority }));
    expect(changedConfigAreas(baseline, draft)).toEqual([scope === "codex" ? "Codex" : "Claude"]);
    const patch = formToPatch(draft);
    const routePatch = scope === "codex" ? patch.primary : patch.claude.primary;
    expect(routePatch).toMatchObject({ api_key_priority: 40, api_keys: [{ id: "fallback", priority: 80 }, { id: "preferred", priority: 10 }, { id: "disabled", priority: 100 }] });
    expect(JSON.stringify(patch)).not.toContain("sk-synthetic-");
    const exported = applyDraftToConfigExport(store.get(), draft);
    const exportRoute = scope === "codex" ? exported.primary : exported.claude.primary;
    expect(exportRoute.api_key_priority).toBe(40);
    expect(exportRoute.api_keys?.[0]).toMatchObject({ priority: 80, api_key: "sk-synthetic-fallback" });
    await store.patch({ ...patch, revision: baseline.revision });
    const saved = store.toPublicConfig();
    const retained = formAfterScopedProfileChange({ ...draft, [`${otherPrefix}ApiKeyPriority`]: 55 }, saved, scope);
    expect(retained[`${prefix}ApiKeyPriority`]).toBe(40);
    expect(retained[`${otherPrefix}ApiKeyPriority`]).toBe(55);
    expect(formAfterScopedProfileChange({ ...draft, [`${prefix}ApiKeyPriority`]: 90 }, saved, scope, draft)[`${prefix}ApiKeyPriority`]).toBe(90);
    const stale = { ...form, [`${prefix}ApiKeyPriority`]: 5 };
    expect(formAfterScopedProfileChange(stale, saved, scope)[`${prefix}ApiKeyPriority`]).toBe(40);
    expect(isFormDirty(saved, formFromConfig(saved))).toBe(false);
  });

  it.each([-1, 101, 1.5, Number.NaN])("rejects invalid priority %s on submission, not while editing", async (priority) => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = priorityConfig();
    await store.patch({ primary: config.primary });
    const baseline = store.toPublicConfig();
    for (const target of ["codexPrimaryApiKeyPriority", "claudePrimaryApiKeyPriority", "pool"] as const) {
      const draft = formFromConfig(baseline);
      if (target === "pool") draft.codexPrimaryApiKeys[0].priority = priority;
      else draft[target] = priority;
      expect(() => isFormDirty(baseline, draft)).not.toThrow();
      expect(isFormDirty(baseline, draft)).toBe(true);
      expect(() => formToPatch(draft)).toThrow(/优先级.*0.*100.*整数/);
      expect(() => applyDraftToConfigExport(store.get(), draft)).toThrow(/优先级.*0.*100.*整数/);
    }
  });

  it("treats a cleared priority as the documented default and detects remote priority conflicts", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    await store.patch({ primary: priorityConfig().primary });
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: store.toPublicConfig() });
    const baselineRevision = state.formRevision;
    const draft = { ...state.form, codexPrimaryApiKeyPriority: "" as const, primaryModelOverride: "unsaved-model" };
    draft.codexPrimaryApiKeys = draft.codexPrimaryApiKeys.map((entry) => ({ ...entry, priority: "" as const }));
    expect(formToPatch(draft).primary).toMatchObject({ api_key_priority: 0, api_keys: [{ priority: 0 }, { priority: 0 }, { priority: 0 }] });
    state = reduceStudioConfigState(state, { type: "set_form", value: draft });
    await store.patch({ primary: { api_key_priority: 90 } });
    state = reduceStudioConfigState(state, { type: "remote_config", config: store.toPublicConfig() });
    expect(state.formRevision).toBe(baselineRevision);
    expect(state.form).toBe(draft);
  });
});

function priorityConfig(keyStrategy: PrimaryKeyStrategy = "fill_first"): CompactGateConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const pool = {
    api_key: "sk-synthetic-direct",
    api_key_priority: 0,
    key_strategy: keyStrategy,
    api_keys: [
      { id: "fallback", label: "Fallback", api_key: "sk-synthetic-fallback", enabled: true, priority: 0 },
      { id: "preferred", label: "Preferred", api_key: "sk-synthetic-preferred", enabled: true, priority: 10 },
      { id: "disabled", label: "Disabled", api_key: "sk-synthetic-disabled", enabled: false, priority: 100 }
    ]
  };
  config.primary = { ...config.primary, ...pool };
  config.claude.primary = { ...config.claude.primary, ...structuredClone(pool) };
  config.profile_scopes = {
    codex: { active_profile_id: "main", profiles: [{ id: "main", name: "Main", created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z", config: { primary: config.primary, compact: config.compact } }] },
    claude: { active_profile_id: null, profiles: [] }
  };
  return config;
}
