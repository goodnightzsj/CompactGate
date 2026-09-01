import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyForm, formFromConfig } from "../src/ui/config/config-form-state.js";
import { createConfigProfilePersistenceActions } from "../src/ui/hooks/configProfilePersistenceActions.js";
import type { ConfigFormState } from "../src/ui/config/types.js";
import { ConfigStore } from "../src/server/config.js";
import type { PublicConfig } from "../src/shared/types.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("config profile persistence", () => {
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
      state: "idle" as const,
      setName: vi.fn(),
      setSelectedId: vi.fn(),
      setState: vi.fn(),
      setError: vi.fn()
    };
    const actions = createConfigProfilePersistenceActions({
      config: null,
      form: currentForm,
      formRevision: null,
      setConfig: vi.fn(),
      setForm: vi.fn(),
      setHealth: vi.fn(),
      setSaveError: vi.fn(),
      setSaveState: vi.fn(),
      scopedProfileAccessors: () => accessors
    });

    await expect(actions.saveConfigProfile("claude", "Mapped")).resolves.toBe(true);
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
      state: "idle" as const,
      setName: vi.fn(),
      setSelectedId: vi.fn(),
      setState: vi.fn(),
      setError: vi.fn()
    };
    const actions = createConfigProfilePersistenceActions({
      config: renamedConfig,
      form: emptyForm(),
      formRevision: null,
      setConfig: vi.fn(),
      setForm: vi.fn(),
      setHealth: vi.fn(),
      setSaveError: vi.fn(),
      setSaveState: vi.fn(),
      scopedProfileAccessors: () => accessors
    });

    await actions.updateSelectedProfile("codex");
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

  it("keeps out-of-scope draft edits when the active profile is saved", async () => {
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
    const setForm = vi.fn();
    const accessors = {
      name: "Active",
      selectedId: profileId,
      state: "idle" as const,
      setName: vi.fn(),
      setSelectedId: vi.fn(),
      setState: vi.fn(),
      setError: vi.fn()
    };
    const actions = createConfigProfilePersistenceActions({
      config: serverConfig,
      form: draft,
      formRevision: null,
      setConfig: vi.fn(),
      setForm,
      setHealth: vi.fn(),
      setSaveError: vi.fn(),
      setSaveState: vi.fn(),
      scopedProfileAccessors: () => accessors
    });

    await actions.updateSelectedProfile("codex");

    expect(setForm).toHaveBeenCalledTimes(1);
    const updater = setForm.mock.calls[0]?.[0] as (current: ConfigFormState) => ConfigFormState;
    const nextForm = updater(draft);
    expect(nextForm.loggingKeepRecent).toBe(999);
    expect(nextForm.claudePrimaryBaseUrl).toBe("https://claude-draft.example");
    // The saved scope adopts the server's answer.
    expect(nextForm.codexPrimaryBaseUrl).toBe("https://saved.example/v1");
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
