import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyForm, formFromConfig, formToPatch } from "../src/ui/config/config-form-state.js";
import { createConfigProfilePersistenceActions } from "../src/ui/hooks/configProfilePersistenceActions.js";
import type { ConfigFormState } from "../src/ui/config/types.js";
import { ConfigStore } from "../src/server/config.js";
import type { PublicConfig } from "../src/shared/types.js";
import { INITIAL_STUDIO_CONFIG_STATE, reduceStudioConfigState } from "../src/ui/config/studio-config-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("config profile persistence", () => {
  it.each(["codex", "claude"] as const)("validates only the submitted %s scope for create and update", async scope => {
    for (const operation of ["save", "update"] as const) {
      const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
      await store.saveProfile(scope, "Synthetic", {});
      const config = store.toPublicConfig();
      const id = config.profile_scopes[scope].profiles[0].id;
      const otherPriority = scope === "codex" ? "claudePrimaryApiKeyPriority" : "codexPrimaryApiKeyPriority";
      const ownPriority = scope === "codex" ? "codexPrimaryApiKeyPriority" : "claudePrimaryApiKeyPriority";
      const form = { ...formFromConfig(config), [otherPriority]: 101 };
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        expect(Object.keys(sent.config).sort()).toEqual(scope === "codex" ? ["compact", "primary"] : ["claude"]);
        if (operation === "save") await store.saveProfile(scope, "Synthetic", sent.config, sent.revision);
        else await store.updateProfile(scope, id, "Synthetic", sent.config, sent.revision);
        return Response.json(store.toPublicConfig());
      });
      vi.stubGlobal("fetch", fetcher);
      vi.stubGlobal("window", { setTimeout: vi.fn() });
      const controls = { name: "Synthetic", selectedId: id, selectionRevision: 0, interactionRevision: 0, state: "idle" as const,
        setName: vi.fn(), commitSavedName: vi.fn(), setSelectedId: vi.fn(), setState: vi.fn(), setError: vi.fn() };
      const makeActions = () => createConfigProfilePersistenceActions({ config, form, formRevision: config.revision,
        setConfig: vi.fn(), applyProfileConfig: vi.fn(), refreshHealthAfterWrite: async () => {},
        setSaveError: vi.fn(), setSaveState: vi.fn(), scopedProfileAccessors: () => controls });
      const submit = () => operation === "save" ? makeActions().saveConfigProfile(scope) : makeActions().updateSelectedProfile(scope, id);
      expect(await submit()).toBe(true);
      expect(form[otherPriority]).toBe(101);
      expect(() => formToPatch(form)).toThrow(/优先级/);
      form[ownPriority] = 101;
      expect(await submit()).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(controls.setError).toHaveBeenLastCalledWith(expect.stringContaining("优先级"));
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves the captured form under an overridden name", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(createdClaudeProfile()), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { setTimeout: vi.fn() });

    const currentForm = {
      ...emptyForm(),
      claudePrimaryBaseUrl: "https://mapped.example/v1",
      claudePrimaryApiKey: "target-draft-key",
      claudePrimaryUpstreamProtocol: "openai_responses" as const,
      claudeCompactBaseUrl: "https://mapped-compact.example/v1",
      claudeCompactUpstreamProtocol: "openai_chat" as const,
      claudeCompactUpstreamMode: "split" as const
    };
    const accessors = {
      name: "",
      selectedId: "",
      selectionRevision: 0,
      interactionRevision: 0,
      state: "idle" as const,
      setName: vi.fn(),
      commitSavedName: vi.fn(),
      setSelectedId: vi.fn(),
      setState: vi.fn(),
      setError: vi.fn()
    };
    const actions = createConfigProfilePersistenceActions({
      config: createdClaudeProfile(),
      form: currentForm,
      formRevision: "loaded-revision",
      setConfig: vi.fn(),
      applyProfileConfig: vi.fn(),
      refreshHealthAfterWrite: async () => undefined,
      setSaveError: vi.fn(),
      setSaveState: vi.fn(),
      scopedProfileAccessors: () => accessors
    });

    await expect(actions.saveConfigProfile("claude", "Mapped")).resolves.toBe(true);
    expect(accessors.commitSavedName).toHaveBeenCalledExactlyOnceWith(
      { name: "", selectedId: "", selectionRevision: 0 }, "created", "Mapped"
    );
    const request = fetchMock.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body));

    expect(payload).toMatchObject({
      scope: "claude",
      name: "Mapped",
      config: {
        claude: {
          primary: {
            base_url: "https://mapped.example/v1",
            api_key: "target-draft-key",
            upstream_protocol: "openai_responses"
          },
          compact: {
            base_url: "https://mapped-compact.example/v1",
            upstream_protocol: "openai_chat",
            upstream_mode: "split"
          }
        }
      }
    });
  });

  it("renames the selected profile through PATCH instead of creating a profile", async () => {
    const renamedConfig = {
      profile_scopes: {
        codex: {
          profiles: [{ id: "current", name: "1zzzcoding" }],
          active_profile_id: null
        },
        claude: { profiles: [], active_profile_id: null }
      }
    } as unknown as PublicConfig;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(renamedConfig), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { setTimeout: vi.fn() });
    const accessors = {
      name: "1zzzcoding",
      selectedId: "current",
      selectionRevision: 0,
      interactionRevision: 0,
      state: "idle" as const,
      setName: vi.fn(),
      commitSavedName: vi.fn(),
      setSelectedId: vi.fn(),
      setState: vi.fn(),
      setError: vi.fn()
    };
    const actions = createConfigProfilePersistenceActions({
      config: renamedConfig,
      form: emptyForm(),
      formRevision: "loaded-revision",
      setConfig: vi.fn(),
      applyProfileConfig: vi.fn(),
      refreshHealthAfterWrite: async () => undefined,
      setSaveError: vi.fn(),
      setSaveState: vi.fn(),
      scopedProfileAccessors: () => accessors
    });

    await actions.updateSelectedProfile("codex");
    expect(accessors.commitSavedName).toHaveBeenCalledExactlyOnceWith(
      { name: "1zzzcoding", selectedId: "current", selectionRevision: 0 }, "current", "1zzzcoding"
    );
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse(String(request?.body));

    expect(url).toBe("/api/config/profiles");
    expect(request?.method).toBe("PATCH");
    expect(payload).toMatchObject({
      scope: "codex",
      profile_id: "current",
      name: "1zzzcoding"
    });
  });

  it.each(["save", "update", "apply"] as const)("keeps out-of-scope and in-flight draft edits during profile %s", async (operation) => {
    // A profile stores only its own slice, so the config that comes back still
    // carries the pre-save logging values. Rebuilding the whole form from it
    // discards edits the server never received.
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    await store.patch({ primary: { base_url: "https://saved.example/v1" } });
    const saved = await store.saveProfile("codex", "Active", {
      primary: { base_url: "https://saved.example/v1" }
    });
    const profileId = saved.profile_scopes?.codex?.profiles?.[0]?.id ?? "";
    await store.applyProfile("codex", profileId);
    const serverConfig = store.toPublicConfig();
    expect(serverConfig.profile_scopes.codex.active_profile_id).toBe(profileId);
    expect(serverConfig.logging.keep_recent).toBe(200);

    const draft = {
      ...formFromConfig(serverConfig),
      // In scope for a codex profile save.
      codexPrimaryBaseUrl: "https://draft.example/v1",
      // Out of scope: only PATCH /api/config persists these.
      loggingKeepRecent: 999,
      claudePrimaryBaseUrl: "https://claude-draft.example"
    };

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(serverConfig), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
    vi.stubGlobal("window", { setTimeout: vi.fn() });
    const setConfig = vi.fn();
    const applyProfileConfig = vi.fn();
    const accessors = {
      name: "Active",
      selectedId: profileId,
      selectionRevision: 0,
      interactionRevision: 0,
      state: "idle" as const,
      setName: vi.fn(),
      commitSavedName: vi.fn(),
      setSelectedId: vi.fn(),
      setState: vi.fn(),
      setError: vi.fn()
    };
    const actions = createConfigProfilePersistenceActions({
      config: serverConfig,
      form: draft,
      formRevision: serverConfig.revision,
      setConfig,
      applyProfileConfig,
      refreshHealthAfterWrite: async () => undefined,
      setSaveError: vi.fn(),
      setSaveState: vi.fn(),
      scopedProfileAccessors: () => accessors
    });

    if (operation === "save") await actions.saveConfigProfile("codex");
    else if (operation === "apply") await actions.applySelectedProfile("codex");
    else await actions.updateSelectedProfile("codex");

    const updater = operation === "apply"
      ? (current: ConfigFormState) => reduceStudioConfigState(
        { ...INITIAL_STUDIO_CONFIG_STATE, config: serverConfig, form: current, formRevision: serverConfig.revision },
        { type: "apply_profile", config: applyProfileConfig.mock.calls[0][0], scope: applyProfileConfig.mock.calls[0][1], baselineConfig: serverConfig, baselineRevision: serverConfig.revision }
      ).form
      : setConfig.mock.calls[0]?.[1] as (current: ConfigFormState) => ConfigFormState;
    if (operation === "apply") expect(applyProfileConfig).toHaveBeenCalledExactlyOnceWith(serverConfig, "codex");
    else expect(setConfig).toHaveBeenCalledTimes(1);
    const nextForm = updater(draft);
    expect(nextForm.loggingKeepRecent).toBe(999);
    expect(nextForm.claudePrimaryBaseUrl).toBe("https://claude-draft.example");
    // The saved scope adopts the server's answer.
    expect(nextForm.codexPrimaryBaseUrl).toBe("https://saved.example/v1");

    // Apply explicitly loads the saved profile; save/update must not erase newer edits.
    if (operation !== "apply") {
      const newerDraft = { ...draft, codexPrimaryBaseUrl: "https://newer-draft.example/v1" };
      expect(updater(newerDraft)).toEqual(newerDraft);
    }

    const otherScopeEdit = { ...draft, claudePrimaryBaseUrl: "https://newer-claude.example" };
    const afterOtherScopeEdit = updater(otherScopeEdit);
    expect(afterOtherScopeEdit.codexPrimaryBaseUrl).toBe("https://saved.example/v1");
    expect(afterOtherScopeEdit.claudePrimaryBaseUrl).toBe(otherScopeEdit.claudePrimaryBaseUrl);
  });
});

function createdClaudeProfile(): PublicConfig {
  return {
    profile_scopes: {
      codex: { profiles: [], active_profile_id: null },
      claude: {
        profiles: [{ id: "created", name: "Mapped" }],
        active_profile_id: null
      }
    }
  } as unknown as PublicConfig;
}
