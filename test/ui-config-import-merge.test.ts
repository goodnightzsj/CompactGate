import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { adoptImportedConnections, applyDraftToConfigExport, formAfterConfigImport, formFromConfig, formToPatch } from "../src/ui/config/config-form-state.js";
import { INITIAL_STUDIO_CONFIG_STATE, reduceStudioConfigState } from "../src/ui/config/studio-config-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

async function prepare(pool: boolean) {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "synthetic.json"));
  const route = (name: string) => ({ base_url: `https://${name}.invalid/v1`, api_key: `synthetic-${name}`, api_key_env: "",
    ...(pool ? { api_keys: [{ id: name, label: name, enabled: true, priority: 0, api_key: `synthetic-pool-${name}` }] } : {}) });
  await store.patch({ primary: route("old"), compact: route("old-compact"), claude: { primary: route("old-claude"), compact: route("old-claude-compact") } });
  const before = store.toPublicConfig();
  await store.importConfig({ primary: route("new"), compact: route("new-compact"), claude: { primary: route("new-claude"), compact: route("new-claude-compact"), model_map: { default: "new-default", opus: "new-opus" } } });
  return { store, before };
}

describe("import followed by another draft write", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])("keeps imported credential owners with pool=%s snapshotFirst=%s", async (pool, snapshotFirst) => {
    const { store, before } = await prepare(pool);
    const imported = store.toPublicConfig();
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: before });
    const submitted = state.form;
    state = reduceStudioConfigState(state, { type: "set_form", value: { ...state.form, primaryModelOverride: "new-edit", claudeModelMap: { ...state.form.claudeModelMap, opus: "edited-opus" } } });
    if (snapshotFirst) state = reduceStudioConfigState(state, { type: "remote_config", config: imported });
    state = reduceStudioConfigState(state, { type: "set_config", value: imported });
    state = reduceStudioConfigState(state, { type: "set_form", value: form => formAfterConfigImport(form, submitted, imported) });
    if (!snapshotFirst) state = reduceStudioConfigState(state, { type: "remote_config", config: imported });
    const expected = store.get();
    expected.primary.model_override = "new-edit";
    expected.claude.model_map.opus = "edited-opus";
    const exported = applyDraftToConfigExport(store.get(), state.form);
    await store.patch(JSON.parse(JSON.stringify({ ...formToPatch(state.form), revision: state.formRevision })));
    for (const result of [exported, store.get()]) {
      for (const [actual, wanted] of [[result.primary, expected.primary], [result.compact, expected.compact], [result.claude.primary, expected.claude.primary], [result.claude.compact, expected.claude.compact]]) {
        expect(actual.base_url).toBe(wanted.base_url);
        expect(actual.api_key).toBe(wanted.api_key);
        expect(actual.api_keys ?? []).toEqual(wanted.api_keys ?? []);
      }
      expect(result.primary.model_override).toBe("new-edit");
      expect(result.claude.model_map.default).toBe("new-default");
      expect(result.claude.model_map.opus).toBe("edited-opus");
    }
  });

  it.each(["codexPrimaryBaseUrl", "codexCompactApiKey", "claudePrimaryApiKeys", "claudeCompactOAuthAccountId"] as const)("preserves and blocks conflicting %s until explicit resolution", async field => {
    const { store, before } = await prepare(true);
    const submitted = formFromConfig(before);
    const draft = { ...submitted, primaryModelOverride: "keep-model", loggingKeepRecent: 500,
      [field]: field === "claudePrimaryApiKeys" ? [{ ...submitted.claudePrimaryApiKeys[0], label: "edited" }] : "edited-during-import" };
    const merged = formAfterConfigImport(draft, submitted, store.toPublicConfig());
    expect(merged[field]).toEqual(draft[field]);
    expect(merged.importConnectionConflict).toBe(true);
    expect(() => formToPatch(merged)).toThrow(/旧凭据/);
    expect(() => applyDraftToConfigExport(store.get(), merged)).toThrow(/旧凭据/);
    const resolved = adoptImportedConnections(merged, store.toPublicConfig());
    expect(resolved.primaryModelOverride).toBe("keep-model");
    expect(resolved.loggingKeepRecent).toBe(500);
    const beforeSave = store.get();
    await store.patch({ ...formToPatch(resolved), revision: store.toPublicConfig().revision });
    expect(store.get().primary.api_key).toBe(beforeSave.primary.api_key);
    expect(store.get().primary.base_url).toBe(beforeSave.primary.base_url);
    expect(store.get().claude.primary.api_keys).toEqual(beforeSave.claude.primary.api_keys);
  });
});
