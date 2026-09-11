import path from "node:path";
import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { formFromConfig, formToPatch } from "../src/ui/config/config-form-state.js";
import { INITIAL_STUDIO_CONFIG_STATE, reduceStudioConfigState, type StudioConfigAction } from "../src/ui/config/studio-config-state.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

afterEach(() => vi.unstubAllGlobals());

describe("profile operations that do not submit a draft", () => {
  it.each(["duplicate", "reorder", "apply"] as const)("keeps an unrelated conflict after %s, with or without an earlier snapshot", async (operation) => {
    for (const sawSnapshot of [false, true]) {
      const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
      await store.saveProfile("codex", "Alpha", { primary: { model_override: "alpha" } });
      await store.saveProfile("codex", "Beta", { primary: { model_override: "beta" } });
      const ids = store.toPublicConfig().profile_scopes.codex.profiles.map((profile) => profile.id);
      await store.applyProfile("codex", ids[0]);
      let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: store.toPublicConfig() });
      const dispatch = (action: StudioConfigAction) => { state = reduceStudioConfigState(state, action); };
      dispatch({ type: "set_form", value: (form) => ({ ...form, claudePrimaryBaseUrl: "https://local-draft.example" }) });
      await store.patch({ claude: { primary: { base_url: "https://other-tab.example" } } });
      if (sawSnapshot) dispatch({ type: "remote_config", config: store.toPublicConfig() });

      if (operation === "duplicate") await store.duplicateProfile("codex", ids[0], "Alpha copy");
      else if (operation === "reorder") await store.reorderProfiles("codex", [...ids].reverse());
      else await store.applyProfile("codex", ids[1]);
      const response = store.toPublicConfig();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response))));
      vi.stubGlobal("window", { setTimeout: vi.fn() });
      let actions!: ReturnType<typeof useConfigActions>;
      function Harness() {
        const baselineConfig = state.config;
        const baselineRevision = state.formRevision;
        actions = useConfigActions({
          ...state, linkedCompactModel: "synthetic",
          commitConfig: (config, submittedRevision) => dispatch({ type: "commit_config", config, submittedRevision }),
          rebaseFormRevision: () => dispatch({ type: "rebase_form_revision" }),
          applyRemoteConfig: (config) => dispatch({ type: "remote_config", config }),
          applyProfileConfig: (config, scope) => dispatch({ type: "apply_profile", config, scope, baselineConfig, baselineRevision }),
          setConfig: (value) => dispatch({ type: "set_config", value }),
          setForm: (value) => dispatch({ type: "set_form", value }),
          setHealth: () => undefined,
          setPageError: () => undefined
        });
        return null;
      }
      renderToStaticMarkup(createElement(Harness));
      if (operation === "duplicate") await actions.duplicateSelectedProfile("codex", ids[0]);
      else if (operation === "reorder") await actions.reorderProfiles("codex", [...ids].reverse());
      else await actions.applySelectedProfile("codex", ids[1]);

      expect(state.config?.revision).toBe(response.revision);
      expect(state.form.claudePrimaryBaseUrl).toBe("https://local-draft.example");
      await expect(store.patch({ ...formToPatch(state.form), revision: state.formRevision })).rejects.toThrow(/superseded revision/);
      expect(store.toPublicConfig().claude.primary.base_url).toBe("https://other-tab.example");
    }
  });
});

describe("config writes and their health follow-up", () => {
  it.each(["save", "update", "apply"] as const)("commits an active profile %s before its health follow-up", async (operation) => {
    const { actions, config, callbacks } = await setup(200, 503, true);
    if (operation === "save") await expect(actions.saveConfigProfile("codex", "Active")).resolves.toBe(true);
    else if (operation === "update") await actions.updateSelectedProfile("codex", config.profile_scopes.codex.active_profile_id!);
    else await actions.applySelectedProfile("codex", config.profile_scopes.codex.active_profile_id!);
    if (operation === "apply") expect(callbacks.applyProfileConfig).toHaveBeenCalledWith(config, "codex");
    else {
      expect(callbacks.setConfig).toHaveBeenCalledWith(config);
      expect(callbacks.setForm).toHaveBeenCalledOnce();
    }
    expect(callbacks.setHealth).toHaveBeenCalledWith(null);
    expect(callbacks.setPageError).toHaveBeenCalledWith(expect.stringContaining("配置已写入，但健康状态刷新失败"));
  });

  it.each(["save", "import"] as const)("keeps a successful %s when health fails", async (operation) => {
    const { actions, config, callbacks, fetchMock } = await setup(200, 503);
    await expect(run(actions, operation)).resolves.toBeUndefined();
    if (operation === "save") expect(callbacks.commitConfig).toHaveBeenCalledWith(config, 3);
    else {
      expect(callbacks.setConfig).toHaveBeenCalledWith(config);
      expect(callbacks.setForm).toHaveBeenCalledWith(formFromConfig(config));
    }
    expect(callbacks.setHealth).toHaveBeenCalledWith(null);
    expect(callbacks.setPageError).toHaveBeenCalledWith(expect.stringContaining("配置已写入，但健康状态刷新失败：Synthetic health failure"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the earlier health warning when a later save refreshes successfully", async () => {
    const { actions, config, callbacks, fetchMock } = await setup(200, 503);
    await run(actions, "save");
    expect(callbacks.setPageError).toHaveBeenLastCalledWith(expect.stringContaining("健康状态刷新失败"));

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(config)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" })));
    await run(actions, "save");

    expect(callbacks.setPageError).toHaveBeenLastCalledWith(null);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(["save", "import"] as const)("does not commit or probe health after a rejected %s", async (operation) => {
    const { actions, callbacks, fetchMock } = await setup(409, 200);
    if (operation === "import") await expect(run(actions, operation)).rejects.toThrow("Synthetic write failure");
    else await run(actions, operation);
    expect(callbacks.commitConfig).not.toHaveBeenCalled();
    expect(callbacks.setConfig).not.toHaveBeenCalled();
    expect(callbacks.setForm).not.toHaveBeenCalled();
    expect(callbacks.setHealth).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function run(actions: ReturnType<typeof useConfigActions>, operation: "save" | "import") {
  return operation === "save"
    ? actions.saveConfig({ preventDefault() {} } as FormEvent)
    : actions.importConfig({ primary: { base_url: "https://synthetic.example/v1" } });
}

async function setup(writeStatus: number, healthStatus: number, activeProfile = false) {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  if (activeProfile) {
    const saved = await store.saveProfile("codex", "Active", {});
    await store.applyProfile("codex", saved.profile_scopes!.codex!.profiles![0].id);
  }
  const config = store.toPublicConfig();
  const callbacks = {
    commitConfig: vi.fn(), rebaseFormRevision: vi.fn(), applyRemoteConfig: vi.fn(), applyProfileConfig: vi.fn(),
    setConfig: vi.fn(), setForm: vi.fn(), setHealth: vi.fn(), setPageError: vi.fn()
  };
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const health = url === "/api/health";
    if (health) {
      expect(callbacks.setConfig.mock.calls.length + callbacks.commitConfig.mock.calls.length + callbacks.applyProfileConfig.mock.calls.length).toBeGreaterThan(0);
    }
    const status = health ? healthStatus : writeStatus;
    return new Response(JSON.stringify(status < 400 ? config : {
      error: health ? "Synthetic health failure" : "Synthetic write failure"
    }), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { setTimeout: vi.fn() });
  let actions!: ReturnType<typeof useConfigActions>;
  function Harness() {
    actions = useConfigActions({ config, form: formFromConfig(config), linkedCompactModel: "synthetic",
      draftRevision: 3, formRevision: config.revision, ...callbacks });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return { actions, config, callbacks, fetchMock };
}
