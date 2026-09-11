import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { resolveRouteCredential } from "../src/server/credentials.js";
import { candidateSignatures, codexPrimaryCandidates } from "../src/server/primary-failover-candidates.js";
import { stateDomainForPrimary } from "../src/server/provider-state-domain.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const stores: ConfigStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.oauth.close()));

async function configured() {
  const configPath = path.join(await makeConfigDir(), "compactgate.json");
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ key: "synthetic-oauth-secret" })));
  const store = await ConfigStore.load(configPath, { fetcher });
  stores.push(store);
  await store.patch({ primary: { base_url: "https://manual.example/v1", api_key: "synthetic-manual", api_key_env: "" } });
  const connect = async () => {
    const session = await store.oauth.start({ provider: "openrouter", label: "OpenRouter", method: "browser" }, "http://127.0.0.1:7865");
    const callback = new URL(new URL(session.authorization_url).searchParams.get("callback_url")!);
    callback.searchParams.set("code", "synthetic-code");
    return (await store.oauth.complete(session.id, callback.href)).account_id!;
  };
  return { store, configPath, id: await connect(), connect };
}

describe("OAuth configuration references", () => {
  it("creates an inactive profile, then applies it without copying manual credentials", async () => {
    const { store, id } = await configured();
    const before = store.get().primary;
    const saved = await store.saveOAuthProfile("codex", id, "OAuth Codex", "provider/model", store.revision);
    expect(saved.primary).toEqual(before);
    expect(saved.active_profile_id).toBeNull();
    const profile = saved.profile_scopes!.codex!.profiles![0];
    expect(profile.config).toMatchObject({ primary: {
      oauth_account_id: id, api_key: "", api_key_env: "", base_url: "https://openrouter.ai/api/v1",
      upstream_protocol: "openai_chat", rotation_opt_out: true, model_override: "provider/model"
    } });
    await store.applyProfile("codex", profile.id);
    expect(resolveRouteCredential("primary", store.get())).toMatchObject({ apiKey: null, apiKeySource: "oauth", oauthAccountId: id });
    expect(resolveRouteCredential("compact", store.get())).toMatchObject({ apiKeySource: "oauth", activeCredentialScope: "primary" });
    expect(store.toPublicConfig().primary).toMatchObject({ oauth_account_id: id, oauth_status: "connected", api_key_configured: true });
    expect(JSON.stringify(store.toPublicConfig())).not.toContain("synthetic-oauth-secret");
  });

  it.each(["codex", "claude"] as const)("preserves same-URL manual presets through %s OAuth profile operations", async (scope) => {
    const { store, id } = await configured();
    const manual = { base_url: "https://openrouter.ai/api/v1", api_key: "synthetic-manual", api_key_env: "SYNTHETIC_MANUAL_KEY" };
    await store.patch({ primary: manual, compact: manual, claude: { primary: manual, compact: manual } });
    const before = store.get();
    const saved = await store.saveOAuthProfile(scope, id, "OAuth", "provider/model", store.revision);
    expect(saved.primary).toEqual(before.primary);
    expect(saved.claude).toEqual(before.claude);
    const profile = saved.profile_scopes![scope]!.profiles![0];
    const assertPresets = () => {
      const presets = store.get().route_url_presets!.filter((preset) => preset.base_url === manual.base_url);
      expect(presets).toHaveLength(4);
      expect(presets.every((preset) => preset.api_key === manual.api_key && preset.api_key_env === manual.api_key_env)).toBe(true);
    };
    assertPresets();
    await store.updateProfile(scope, profile.id, "Updated OAuth", undefined);
    assertPresets();
    await store.duplicateProfile(scope, profile.id, "OAuth copy");
    await store.duplicateProfile(scope, profile.id, "Other client OAuth", scope === "codex" ? "claude" : "codex");
    assertPresets();
    await store.applyProfile(scope, profile.id);
    await store.patch({ logging: { keep_recent: 123 } });
    assertPresets();
  });

  it("does not record independent OAuth compact routes as manual URL presets", async () => {
    const { store, id } = await configured();
    const manual = { base_url: "https://openrouter.ai/api/v1", api_key: "synthetic-compact", api_key_env: "" };
    await store.patch({ compact: manual, claude: { compact: manual } });
    const bound = { ...manual, api_key: "", oauth_account_id: id, upstream_protocol: "openai_chat", upstream_mode: "split" };
    await store.patch({ compact: bound, claude: { compact: bound } });
    for (const kind of ["codex_compact", "claude_compact"]) {
      expect(store.get().route_url_presets!.find((preset) => preset.kind === kind && preset.base_url === manual.base_url)?.api_key).toBe(manual.api_key);
    }
  });

  it("requires explicit removal before switching to manual credentials and forbids arbitrary OAuth destinations", async () => {
    const { store, id } = await configured();
    await expect(store.patch({ primary: { oauth_account_id: id } })).rejects.toThrow(/mutually exclusive/);
    await store.patch({ primary: { oauth_account_id: id, api_key: "", api_key_env: "", base_url: "https://openrouter.ai/api/v1", upstream_protocol: "openai_chat" } });
    for (const patch of [
      { api_key: "synthetic-new-key" }, { api_key_env: "NEW_KEY" }, { api_keys: [{ id: "one", api_key: "key" }] },
      { base_url: "https://evil.example/v1" }, { upstream_protocol: "openai_responses" }
    ]) await expect(store.patch({ primary: patch })).rejects.toThrow(/OAuth/);
    await store.patch({ primary: { oauth_account_id: null, api_key: "synthetic-new-key", base_url: "https://manual.example/v1" } });
    expect(resolveRouteCredential("primary", store.get())).toMatchObject({ apiKeySource: "config", apiKey: "synthetic-new-key" });
    expect(store.get().primary.oauth_account_id).toBeUndefined();
  });

  it("keeps references through rename, duplicate, cross-scope copy, export and reload", async () => {
    const { store, id, configPath } = await configured();
    await store.saveOAuthProfile("codex", id, "Original", "provider/model", store.revision);
    const first = store.toPublicConfig().profiles[0];
    await store.updateProfile("codex", first.id, "Renamed", undefined);
    await store.duplicateProfile("codex", first.id, "Copy");
    await store.duplicateProfile("codex", first.id, "Claude copy", "claude");
    const claude = store.get().profile_scopes!.claude!.profiles![0];
    expect(claude.config).toMatchObject({ claude: { primary: { oauth_account_id: id, api_key_env: "", upstream_protocol: "openai_chat" } } });
    await store.applyProfile("codex", first.id);
    await store.patch({ logging: { keep_recent: 44 } });
    const exported = JSON.stringify(store.get());
    expect(exported).toContain(id);
    expect(exported).not.toContain("synthetic-oauth-secret");
    for (const backup of await store.listBackups()) {
      expect(await readFile(path.join(path.dirname(configPath), backup.id), "utf8")).not.toContain("synthetic-oauth-secret");
    }
    const loaded = await ConfigStore.load(configPath);
    stores.push(loaded);
    expect(loaded.get()).toEqual(store.get());
    expect(loaded.toPublicConfig().primary.oauth_status).toBe("connected");
  });

  it("does not overwrite same-name profiles or bypass revision conflicts", async () => {
    const { store, id } = await configured();
    const revision = store.revision;
    const results = await Promise.allSettled([
      store.saveOAuthProfile("codex", id, "One", "model", revision),
      store.saveOAuthProfile("codex", id, "Two", "model", revision)
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const name = store.toPublicConfig().profiles[0].name;
    await expect(store.saveOAuthProfile("codex", id, name, "different-model", store.revision)).rejects.toThrow(/never overwrites/);
    expect(store.toPublicConfig().profiles).toHaveLength(1);
  });

  it("imports portable references as missing instead of importing or falling back to other credentials", async () => {
    const { store, id } = await configured();
    await store.saveOAuthProfile("codex", id, "Portable", "model", store.revision);
    await store.applyProfile("codex", store.toPublicConfig().profiles[0].id);
    const other = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    stores.push(other);
    await other.importConfig(store.get());
    expect(other.toPublicConfig().primary).toMatchObject({ oauth_status: "missing", api_key_configured: false, api_key_source: "oauth" });
    await expect(other.oauth.credentials(id)).rejects.toMatchObject({ status: 401 });
    expect(other.get().primary.oauth_account_id).toBe(id);
  });

  it("keeps API-key failover candidates independent of the active OAuth profile", async () => {
    const { store, id, connect } = await configured();
    await store.saveProfile("codex", "Manual", {});
    await store.saveOAuthProfile("codex", id, "OAuth", "model", store.revision);
    const oauthProfile = store.toPublicConfig().profiles.find((p) => p.name === "OAuth")!;
    await store.applyProfile("codex", oauthProfile.id);
    const candidates = codexPrimaryCandidates(store.get());
    const manual = candidates.find((item) => item.name === "Manual")!;
    expect(resolveRouteCredential("primary", manual.config)).toMatchObject({ apiKey: "synthetic-manual", apiKeySource: "config" });
    const previousSignatures = candidateSignatures(candidates);
    const previousDomain = stateDomainForPrimary(store.get().primary, oauthProfile.id);
    const newId = await connect();
    await store.patch({ primary: { oauth_account_id: newId } });
    expect(stateDomainForPrimary(store.get().primary, oauthProfile.id)).not.toBe(previousDomain);
    expect(candidateSignatures(codexPrimaryCandidates(store.get())).get(oauthProfile.id)).not.toBe(previousSignatures.get(oauthProfile.id));
    expect(candidateSignatures(codexPrimaryCandidates(store.get())).get(manual.id)).toBe(previousSignatures.get(manual.id));
  });

  it("disconnect leaves profile references intact and public health visibly unavailable", async () => {
    const { store, id } = await configured();
    await store.saveOAuthProfile("claude", id, "Claude OAuth", "model", store.revision);
    await store.applyProfile("claude", store.toPublicConfig().profile_scopes.claude.profiles[0].id);
    const revision = store.revision;
    await store.oauth.disconnect(id);
    expect(store.revision).toBe(revision);
    expect(store.toPublicConfig().claude.primary).toMatchObject({ oauth_status: "disconnected", oauth_account_id: id, api_key_configured: false });
  });
});
