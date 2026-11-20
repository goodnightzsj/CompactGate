import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { adoptImportedConnections, formAfterConfigConflict, formFromConfig, formToPatch } from "../src/ui/config/config-form-state.js";
import { INITIAL_STUDIO_CONFIG_STATE, reduceStudioConfigState, type StudioConfigAction } from "../src/ui/config/studio-config-state.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { startApp, startUpstream, writeJsonResponse } from "./helpers/server-test-utils.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["codex", "claude"] as const)("merges only edited fields after a %s profile conflict", async scope => {
  const received: string[] = [];
  const upstream = (name: string) => startUpstream((req, res) => {
    received.push(`${name}:${req.headers.authorization ?? req.headers["x-api-key"]}`);
    writeJsonResponse(res, { object: "list", data: [] });
  });
  const a = await upstream("A");
  const b = await upstream("B");
  const app = await startApp();
  const route = (base_url: string, api_key: string) => scope === "codex"
    ? { primary: { base_url, api_key, api_key_env: "" } }
    : { claude: { primary: { base_url, api_key, api_key_env: "" } } };
  await app.config.saveProfile(scope, "A", route(a.url, "synthetic-A"));
  await app.config.saveProfile(scope, "B", route(b.url, "synthetic-B"));
  const profiles = app.config.toPublicConfig().profile_scopes[scope].profiles;
  await app.config.applyProfile(scope, profiles.find(p => p.name === "A")!.id);
  let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: app.config.toPublicConfig(), baselineConfig: null });
  const dispatch = (action: StudioConfigAction) => { state = reduceStudioConfigState(state, action); };
  dispatch({ type: "set_form", value: form => ({ ...form, loggingKeepRecent: 123 }) });
  await app.config.applyProfile(scope, profiles.find(p => p.name === "B")!.id);
  dispatch({ type: "remote_config", config: app.config.toPublicConfig() });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) =>
    originalFetch(typeof input === "string" && input.startsWith("/") ? `${app.url}${input}` : input, init)));
  vi.stubGlobal("window", { setTimeout: vi.fn() });
  let actions!: ReturnType<typeof useConfigActions>;
  function Harness() {
    actions = useConfigActions({ ...state, linkedCompactModel: "synthetic",
      commitConfig: async (config, submittedRevision) => dispatch({ type: "commit_config", config, submittedRevision }),
      applyWrittenConfig: async () => {}, applyProfileConfig: async () => {},
      setConfig: async (value, form) => dispatch({ type: "set_config", value, form }),
      setForm: value => dispatch({ type: "set_form", value }),
      refreshHealthAfterWrite: async () => {} });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  await actions.saveConfig({ preventDefault() {} } as FormEvent);
  expect(app.config.get().logging.keep_recent).not.toBe(123);
  await actions.overrideSaveConflict({ preventDefault() {} } as FormEvent);
  expect(app.config.get().logging.keep_recent).toBe(123);
  const response = await originalFetch(`${app.url}${scope === "codex" ? "/v1/models" : "/anthropic/v1/models"}`);
  expect(response.status).toBe(200);
  await response.text();
  expect(received).toEqual(["B:Bearer synthetic-B"]);
  expect(state.formRevision).toBe(state.config!.revision);
});

it.each(["primary", "compact", "claude_primary", "claude_compact"] as const)(
  "does not rebase edited %s connections across hidden credential changes", async kind => {
    const app = await startApp();
    const route = { api_key: "synthetic-first-same", api_keys: [
      { id: "pool", label: "pool", enabled: true, priority: 100, api_key: "synthetic-pool" }
    ] };
    const patch = (value: typeof route) => kind === "primary" || kind === "compact"
      ? { [kind]: value } : { claude: { [kind === "claude_primary" ? "primary" : "compact"]: value } };
    await app.config.patch(patch(route));
    const before = app.config.toPublicConfig();
    const prefix = { primary: "codexPrimary", compact: "codexCompact", claude_primary: "claudePrimary", claude_compact: "claudeCompact" }[kind];
    const draft = { ...formFromConfig(before), [`${prefix}BaseUrl`]: "https://edited.example/v1", loggingKeepRecent: 123 };
    await app.config.patch(patch({ ...route, api_key: "synthetic-next-same" }));
    const saved = app.config.toPublicConfig();
    let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: before, baselineConfig: null });
    state = reduceStudioConfigState(state, { type: "set_form", value: draft });
    state = reduceStudioConfigState(state, { type: "remote_config", config: saved });
    expect(state.formRevision).toBe(before.revision);
    const merged = formAfterConfigConflict(draft, before, saved);
    expect(merged.importConnectionConflict).toBe(true);
    expect(merged.loggingKeepRecent).toBe(123);
    expect(() => formToPatch(merged)).toThrow(/旧凭据/);
    state = reduceStudioConfigState(state, { type: "set_form", value: merged });
    state = reduceStudioConfigState(state, { type: "set_form", value: form => adoptImportedConnections(form, saved) });
    expect(state.formRevision).toBe(saved.revision);
    expect(state.formBaseline).toBe(saved);
    expect(state.form.loggingKeepRecent).toBe(123);
    expect(state.form.importConnectionConflict).toBe(false);
    expect(formToPatch(state.form)).toBeDefined();
  }
);

it("keeps an explicit connection edit when the remote change only edits logging", async () => {
  const app = await startApp();
  const before = app.config.toPublicConfig();
  const draft = { ...formFromConfig(before), codexPrimaryBaseUrl: "https://edited.example/v1", codexPrimaryApiKey: "synthetic-new" };
  await app.config.patch({ logging: { keep_recent: 123 } });
  const merged = formAfterConfigConflict(draft, before, app.config.toPublicConfig());
  expect(merged.importConnectionConflict).toBe(false);
  expect(formToPatch(merged).primary).toMatchObject({ base_url: draft.codexPrimaryBaseUrl, api_key: "synthetic-new" });
  expect(merged.loggingKeepRecent).toBe(123);
});

it("does not turn adopted remote fields into edits after a refused connection override", async () => {
  const app = await startApp();
  const before = app.config.toPublicConfig();
  let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: before, baselineConfig: null });
  const dispatch = (action: StudioConfigAction) => { state = reduceStudioConfigState(state, action); };
  dispatch({ type: "set_form", value: form => ({ ...form, codexPrimaryBaseUrl: "https://edited.example/v1", loggingKeepRecent: 123 }) });
  await app.config.patch({ primary: { api_key: "synthetic-B", model_override: "remote-B" } });
  dispatch({ type: "remote_config", config: app.config.toPublicConfig() });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  let actions!: ReturnType<typeof useConfigActions>;
  function Harness() {
    actions = useConfigActions({ ...state, linkedCompactModel: "synthetic",
      commitConfig: async () => {}, applyWrittenConfig: async () => {}, applyProfileConfig: async () => {},
      setConfig: async (value, form) => dispatch({ type: "set_config", value, form }),
      setForm: value => dispatch({ type: "set_form", value }),
      refreshHealthAfterWrite: async () => {} });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  await actions.overrideSaveConflict({ preventDefault() {} } as FormEvent);
  expect(fetcher).not.toHaveBeenCalled();
  expect(state.form.importConnectionConflict).toBe(true);
  await app.config.patch({ primary: { model_override: "remote-C" } });
  const current = app.config.toPublicConfig();
  dispatch({ type: "remote_config", config: current });
  dispatch({ type: "set_form", value: form => adoptImportedConnections(form, current) });
  expect(state.form.primaryModelOverride).toBe("remote-C");
  expect(state.form.loggingKeepRecent).toBe(123);
  expect(state.formRevision).toBe(current.revision);
});

it.each([false, true])("keeps draft ownership through an override, accepted=%s", async accepted => {
  const app = await startApp();
  const before = app.config.toPublicConfig();
  let state = reduceStudioConfigState(INITIAL_STUDIO_CONFIG_STATE, { type: "bootstrap", config: before, baselineConfig: null });
  const dispatch = (action: StudioConfigAction) => { state = reduceStudioConfigState(state, action); };
  dispatch({ type: "set_form", value: form => ({ ...form, loggingKeepRecent: 123 }) });
  await app.config.patch({ primary: { model_override: "remote-model" } });
  const saved = app.config.toPublicConfig();
  dispatch({ type: "remote_config", config: saved });
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  vi.stubGlobal("window", { setTimeout: vi.fn() });
  let actions!: ReturnType<typeof useConfigActions>;
  function Harness() {
    actions = useConfigActions({ ...state, linkedCompactModel: "synthetic",
      commitConfig: async () => {}, applyWrittenConfig: async () => {}, applyProfileConfig: async () => {},
      setConfig: async (value, form) => dispatch({ type: "set_config", value, form }),
      setForm: value => dispatch({ type: "set_form", value }),
      refreshHealthAfterWrite: async () => {} });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  const pending = actions.overrideSaveConflict({ preventDefault() {} } as FormEvent);
  expect(state.formRevision).toBe(before.revision);
  dispatch({ type: "set_form", value: form => ({ ...form, loggingKeepRecent: 321 }) });
  finish(accepted ? Response.json(saved) : Response.json({ error: "synthetic failed write" }, { status: 500 }));
  await pending;
  expect(state.form.loggingKeepRecent).toBe(321);
  expect(state.formRevision).toBe(accepted ? saved.revision : before.revision);
  expect(state.formBaseline).toEqual(accepted ? saved : before);
  if (accepted) expect(state.form.primaryModelOverride).toBe("remote-model");
});
