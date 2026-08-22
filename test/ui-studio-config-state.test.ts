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
    expect(studioBootstrapScope("analytics")).toBe("studio");
    expect(studioBootstrapScope("usage")).toBe("studio");
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

  it("preserves a dirty draft when the bootstrap effect re-runs", async () => {
    // Navigating to the health page and back re-runs useStudioBootstrap, which
    // refetches /api/config and dispatches bootstrap a second time. That must
    // not throw away edits the user has not saved yet.
    const store = await loadStore();
    const current = store.toPublicConfig();
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, {
      type: "bootstrap",
      config: current
    });
    state = reduceStudioConfigState(state, {
      type: "set_form",
      value: (form) => ({ ...form, codexPrimaryBaseUrl: "http://draft.local/v1" })
    });
    expect(state.config && isFormDirty(state.config, state.form)).toBe(true);

    state = reduceStudioConfigState(state, { type: "bootstrap", config: current });

    expect(state.form.codexPrimaryBaseUrl).toBe("http://draft.local/v1");
    expect(state.config && isFormDirty(state.config, state.form)).toBe(true);
  });

  it("adopts the fetched config on a re-bootstrap when the form is clean", async () => {
    const store = await loadStore();
    const current = store.toPublicConfig();
    const next = structuredClone(current);
    next.primary.base_url = "http://127.0.0.1:9903/v1";
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, {
      type: "bootstrap",
      config: current
    });

    state = reduceStudioConfigState(state, { type: "bootstrap", config: next });

    expect(state.config?.primary.base_url).toBe("http://127.0.0.1:9903/v1");
    expect(state.form.codexPrimaryBaseUrl).toBe("http://127.0.0.1:9903/v1");
  });

  it("keeps a dirty draft pinned to the revision it was built from", async () => {
    // The whole point of the server-side revision guard: a snapshot broadcast
    // by another tab must not silently re-base this tab's draft, or the guard
    // would accept exactly the lost update it exists to reject.
    const store = await loadStore();
    const current = store.toPublicConfig();
    const remote = structuredClone(current);
    remote.primary.base_url = "http://127.0.0.1:9904/v1";
    remote.revision = "r-other-tab";

    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, {
      type: "bootstrap",
      config: current
    });
    expect(state.formRevision).toBe(current.revision);

    state = reduceStudioConfigState(state, {
      type: "set_form",
      value: (form) => ({ ...form, codexPrimaryBaseUrl: "http://draft.local/v1" })
    });
    state = reduceStudioConfigState(state, { type: "remote_config", config: remote });

    expect(state.config?.revision).toBe("r-other-tab");
    expect(state.formRevision).toBe(current.revision);

    // A clean form has nothing to lose, so it re-bases along with the snapshot.
    const rebased = reduceStudioConfigState(
      reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: current }),
      { type: "remote_config", config: remote }
    );
    expect(rebased.formRevision).toBe("r-other-tab");
  });

  it("does not dead-end a dirty draft when a snapshot changes nothing the form covers", async () => {
    // `revision` embeds the process boot time, so restarting the proxy changes
    // the string wholesale while the config on disk stays byte-identical. The
    // reconnecting SSE stream then pushes a snapshot; pinning formRevision
    // through that made every later save fail forever with no in-app way back.
    const store = await loadStore();
    const current = store.toPublicConfig();
    const afterRestart = structuredClone(current);
    afterRestart.revision = "rDIFFERENTBOOT-0";

    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, {
      type: "bootstrap",
      config: current
    });
    state = reduceStudioConfigState(state, {
      type: "set_form",
      value: (form) => ({ ...form, codexPrimaryBaseUrl: "http://draft.local/v1" })
    });
    state = reduceStudioConfigState(state, { type: "remote_config", config: afterRestart });

    expect(state.form.codexPrimaryBaseUrl).toBe("http://draft.local/v1");
    expect(state.formRevision).toBe("rDIFFERENTBOOT-0");

    // A snapshot that moves a field the form does carry is a real conflict and
    // still keeps the draft pinned to its own baseline.
    const foreignEdit = structuredClone(current);
    foreignEdit.revision = "rOTHER-9";
    foreignEdit.primary.base_url = "http://someone-else.local/v1";
    const conflicted = reduceStudioConfigState(state, {
      type: "remote_config",
      config: foreignEdit
    });
    expect(conflicted.formRevision).toBe("rDIFFERENTBOOT-0");

    // ...and the operator can deliberately override it without losing the draft.
    const overridden = reduceStudioConfigState(conflicted, { type: "rebase_form_revision" });
    expect(overridden.formRevision).toBe("rOTHER-9");
    expect(overridden.form.codexPrimaryBaseUrl).toBe("http://draft.local/v1");
  });

  it("re-bases the draft on this tab's own successful writes", async () => {
    const store = await loadStore();
    const current = store.toPublicConfig();
    const saved = structuredClone(current);
    saved.revision = "r-ours";

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

    // Our patch landed, so the edits made while it was in flight now sit on top
    // of what came back. Keeping the old revision would block the next save.
    expect(state.form.codexPrimaryBaseUrl).toBe("http://new-edit.local/v1");
    expect(state.formRevision).toBe("r-ours");

    const viaProfileWrite = reduceStudioConfigState(state, {
      type: "set_config",
      value: { ...saved, revision: "r-profile-write" }
    });
    expect(viaProfileWrite.formRevision).toBe("r-profile-write");
  });
});

async function loadStore(): Promise<ConfigStore> {
  const dir = await makeConfigDir();
  return ConfigStore.load(path.join(dir, "compactgate.json"));
}
