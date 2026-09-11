import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { OAuthProfilesPanel } from "../src/ui/config/OAuthProfilesPanel.js";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import {
  applyDraftToConfigExport, changedConfigAreas, formAfterScopedProfileChange,
  formFromConfig, formToPatch, formWithOAuthAccount, isFormDirty
} from "../src/ui/config/config-form-state.js";
import { INITIAL_STUDIO_CONFIG_STATE, reduceStudioConfigState } from "../src/ui/config/studio-config-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";

const stores: ConfigStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.oauth.close()));

async function configured() {
  const issuer = oauthTestProvider("openrouter");
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"), issuer);
  stores.push(store);
  const manual = { base_url: "https://manual.example/v1", api_key: "synthetic-manual", api_key_env: "" };
  await store.patch({ primary: manual, compact: manual, claude: { primary: manual, compact: manual } });
  const id = await issuer.authorize(store.oauth);
  const account = store.oauth.get(id);
  if (!account) throw new Error("Synthetic authorization did not create an account.");
  return { store, account, issuer };
}

const routes = [
  ["codex_primary", "codexPrimary", "codex"], ["codex_compact", "codexCompact", "codex"],
  ["claude_primary", "claudePrimary", "claude"], ["claude_compact", "claudeCompact", "claude"]
] as const;

describe("OAuth configuration UI contracts", () => {
  it.each(routes)("round-trips %s from manual to OAuth and back", async (kind, prefix, scope) => {
    const { store, account } = await configured();
    const before = store.toPublicConfig();
    const oldForm = {
      ...formFromConfig(before), [`${prefix}ApiKey`]: "synthetic-typed",
      [`${prefix}CredentialPresetId`]: "stale-preset"
    };
    const bound = formWithOAuthAccount(oldForm, kind, account);
    expect(bound[`${prefix}ApiKey`]).toBe("");
    expect(bound[`${prefix}CredentialPresetId`]).toBe("");
    expect(changedConfigAreas(before, bound)).toEqual([scope === "codex" ? "Codex" : "Claude"]);
    const patch = formToPatch(bound);
    const selectedPatch = (scope === "codex" ? patch : patch.claude)[kind.endsWith("primary") ? "primary" : "compact"];
    expect(selectedPatch).toMatchObject({
      oauth_account_id: account.id, base_url: account.base_url, upstream_protocol: account.upstream_protocol,
      api_key: "", api_key_env: "", api_keys: []
    });
    const exported = applyDraftToConfigExport(store.get(), bound);
    const selectedExport = (scope === "codex" ? exported : exported.claude)[kind.endsWith("primary") ? "primary" : "compact"];
    expect(selectedExport).toMatchObject({ oauth_account_id: account.id, api_key: "", api_key_env: "" });
    expect(JSON.stringify(exported)).not.toContain("synthetic-openrouter-key");
    await store.patch(patch);
    expect(formFromConfig(store.toPublicConfig())[`${prefix}OAuthAccountId`]).toBe(account.id);
    expect(isFormDirty(store.toPublicConfig(), formFromConfig(store.toPublicConfig()))).toBe(false);

    const manual = {
      ...formWithOAuthAccount(formFromConfig(store.toPublicConfig()), kind, null),
      [`${prefix}BaseUrl`]: "https://manual.example/v1", [`${prefix}ApiKey`]: "synthetic-new"
    };
    const manualPatch = formToPatch(manual);
    expect((scope === "codex" ? manualPatch : manualPatch.claude)[kind.endsWith("primary") ? "primary" : "compact"])
      .toMatchObject({ oauth_account_id: null, api_key: "synthetic-new" });
    await store.patch(manualPatch);
    expect(formFromConfig(store.toPublicConfig())[`${prefix}OAuthAccountId`]).toBe("");
    expect(JSON.stringify(applyDraftToConfigExport(store.get(), manual))).not.toContain(account.id);
  });

  it("clears primary key pools and detects an account-only change on the same host", async () => {
    const { store, account, issuer } = await configured();
    let form = formFromConfig(store.toPublicConfig());
    for (const kind of ["codex_primary", "claude_primary"] as const) {
      form.codexPrimaryApiKeys = [{ id: "old", label: "Old", apiKey: "synthetic-typed", enabled: true, tail: "" }];
      form.claudePrimaryApiKeys = form.codexPrimaryApiKeys;
      const bound = formWithOAuthAccount(form, kind, account);
      const prefix = kind === "codex_primary" ? "codexPrimary" : "claudePrimary";
      expect(bound[`${prefix}ApiKeys`]).toEqual([]);
      expect(bound[`${prefix}RotationOptOut`]).toBe(true);
    }
    await store.patch(formToPatch(formWithOAuthAccount(formFromConfig(store.toPublicConfig()), "codex_primary", account)));
    const newId = await issuer.authorize(store.oauth);
    const changed = formWithOAuthAccount(formFromConfig(store.toPublicConfig()), "codex_primary", store.oauth.get(newId));
    expect(isFormDirty(store.toPublicConfig(), changed)).toBe(true);
    expect(changedConfigAreas(store.toPublicConfig(), changed)).toEqual(["Codex"]);
  });

  it.each(["codex", "claude"] as const)("updates only the %s OAuth fields after a scoped profile change", async (scope) => {
    const { store, account } = await configured();
    let draft = formFromConfig(store.toPublicConfig());
    for (const [kind] of routes) draft = formWithOAuthAccount(draft, kind, account);
    draft.loggingKeepRecent += 1;
    const after = formAfterScopedProfileChange(draft, store.toPublicConfig(), scope);
    for (const [, prefix, routeScope] of routes) {
      expect(after[`${prefix}OAuthAccountId`]).toBe(routeScope === scope ? "" : account.id);
    }
    expect(after.loggingKeepRecent).toBe(draft.loggingKeepRecent);
  });

  it("creating an OAuth profile preserves pending drafts and the active runtime", async () => {
    const { store, account } = await configured();
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: store.toPublicConfig() });
    state = reduceStudioConfigState(state, { type: "set_form", value: { ...state.form, primaryModelOverride: "unsaved-model", loggingKeepRecent: 123 } });
    const before = state;
    await store.saveOAuthProfile("codex", account.id, "OAuth draft", "provider/model", state.config!.revision);
    state = reduceStudioConfigState(state, { type: "remote_config", config: store.toPublicConfig() });
    expect(state.form).toBe(before.form);
    expect(state.config!.primary).toEqual(before.config!.primary);
    expect(state.formRevision).toBe(state.config!.revision);
    expect(state.config!.profile_scopes.codex.active_profile_id).toBeNull();
    expect(state.config!.profile_scopes.codex.profiles[0].oauth_account_id).toBe(account.id);
  });

  it("an OAuth profile creation cannot rebase an already conflicted draft", async () => {
    const { store, account } = await configured();
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: store.toPublicConfig() });
    const originalRevision = state.formRevision;
    state = reduceStudioConfigState(state, { type: "set_form", value: { ...state.form, primaryModelOverride: "unsaved-model" } });
    await store.patch({ primary: { model_override: "other-tab-model" } });
    state = reduceStudioConfigState(state, { type: "remote_config", config: store.toPublicConfig() });
    expect(state.formRevision).toBe(originalRevision);
    await store.saveOAuthProfile("codex", account.id, "OAuth while conflicted", "provider/model", store.revision);
    state = reduceStudioConfigState(state, { type: "remote_config", config: store.toPublicConfig() });
    expect(state.formRevision).toBe(originalRevision);
    expect(state.form.primaryModelOverride).toBe("unsaved-model");
    expect(state.config!.primary.model_override).toBe("other-tab-model");
    expect(state.config!.profile_scopes.codex.profiles[0].name).toBe("OAuth while conflicted");
  });

  it.each(["codex", "claude"] as const)("hides manual credentials for bound %s routes", async (scope) => {
    const { store, account } = await configured();
    let form = formFromConfig(store.toPublicConfig());
    for (const [kind, , routeScope] of routes) if (routeScope === scope) form = formWithOAuthAccount(form, kind, account);
    const markup = renderToStaticMarkup(<RouteConfigPanel config={store.toPublicConfig()} scope={scope} form={form} onFormChange={() => {}} onManageOAuth={() => {}} />);
    expect(markup.match(/class="oauth-route-summary"/g)).toHaveLength(2);
    expect(markup).not.toContain('type="password"');
    expect(markup).toContain("管理授权连接");
    expect(markup).toContain(account.base_url);
    expect(markup).not.toContain("<select");
    expect(markup).toContain(`aria-label="${scope === "codex" ? "Codex" : "Claude"} 主路由 认证来源"`);
  });

  it("renders project OAuth controls and explains the separate connection and profile steps", () => {
    const markup = renderToStaticMarkup(<OAuthProfilesPanel config={null} onConfigChange={() => {}} onProfileLocate={() => {}} />);
    expect(markup).not.toMatch(/<(select|datalist)\b/);
    expect(markup).not.toContain('type="radio"');
    expect(markup).toContain('aria-label="模型厂商"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('class="toggle-group"');
    expect(markup).toContain("授权只新增连接");
    expect(markup).toContain("全局共享");
    expect(markup).toContain('aria-label="接入步骤"');
    expect(markup).toContain("不会覆盖当前激活档案");
    expect(markup).toContain("Claude.ai 订阅不提供第三方登录接入");
    expect(markup).not.toContain("access_token");
    expect(markup).not.toContain("refresh_token");
  });
});
