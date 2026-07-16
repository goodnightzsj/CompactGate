import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import {
  INITIAL_STUDIO_CONFIG_STATE,
  reduceStudioConfigState
} from "../src/ui/config/studio-config-state.js";
import { isFormDirty } from "../src/ui/config/config-form-state.js";
import { studioBootstrapScope } from "../src/ui/hooks/useStudioBootstrap.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("Studio config ownership", () => {
  it("keeps one bootstrap scope across internal Studio navigation", () => {
    expect(studioBootstrapScope("dashboard")).toBe("studio");
    expect(studioBootstrapScope("routes")).toBe("studio");
    expect(studioBootstrapScope("config")).toBe("studio");
    expect(studioBootstrapScope("logs")).toBe("studio");
    expect(studioBootstrapScope("health")).toBe("health");
  });

  it("updates a clean form when a remote runtime config arrives", async () => {
    const store = await loadStore();
    const current = store.toPublicConfig();
    const next = structuredClone(current);
    next.primary.base_url = "http://127.0.0.1:9901/v1";
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, {
      type: "bootstrap",
      config: current
    });

    state = reduceStudioConfigState(state, { type: "remote_config", config: next });

    expect(state.config?.primary.base_url).toBe("http://127.0.0.1:9901/v1");
    expect(state.form.codexPrimaryBaseUrl).toBe("http://127.0.0.1:9901/v1");
  });

  it("preserves a dirty draft when remote runtime config changes", async () => {
    const store = await loadStore();
    const current = store.toPublicConfig();
    const next = structuredClone(current);
    next.primary.base_url = "http://127.0.0.1:9902/v1";
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, {
      type: "bootstrap",
      config: current
    });
    state = reduceStudioConfigState(state, {
      type: "set_form",
      value: (form) => ({ ...form, codexPrimaryBaseUrl: "http://draft.local/v1" })
    });

    state = reduceStudioConfigState(state, { type: "remote_config", config: next });

    expect(state.config?.primary.base_url).toBe("http://127.0.0.1:9902/v1");
    expect(state.form.codexPrimaryBaseUrl).toBe("http://draft.local/v1");
  });

  it("does not erase edits made while an earlier save is completing", async () => {
    const store = await loadStore();
    const current = store.toPublicConfig();
    const saved = structuredClone(current);
    saved.primary.base_url = "http://submitted.local/v1";
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, {
      type: "bootstrap",
      config: current
    });
    state = reduceStudioConfigState(state, {
      type: "set_form",
      value: (form) => ({ ...form, codexPrimaryBaseUrl: "http://submitted.local/v1" })
    });
    const submittedRevision = state.draftRevision;
    state = reduceStudioConfigState(state, {
      type: "set_form",
      value: (form) => ({ ...form, codexPrimaryBaseUrl: "http://new-edit.local/v1" })
    });

    state = reduceStudioConfigState(state, {
      type: "commit_config",
      config: saved,
      submittedRevision
    });

    expect(state.form.codexPrimaryBaseUrl).toBe("http://new-edit.local/v1");
    expect(state.config?.primary.base_url).toBe("http://submitted.local/v1");
    expect(state.config && isFormDirty(state.config, state.form)).toBe(true);
  });
});

async function loadStore(): Promise<ConfigStore> {
  const dir = await makeConfigDir();
  return ConfigStore.load(path.join(dir, "compactgate.json"));
}
