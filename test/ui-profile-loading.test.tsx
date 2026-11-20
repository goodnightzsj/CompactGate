// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import type { ConfigProfileScope } from "../src/shared/types.js";
import { ProfileScopeCard } from "../src/ui/config/ProfileScopeCard.js";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { useStudioBootstrap } from "../src/ui/hooks/useStudioBootstrap.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

let root: Root | undefined;
let store: ConfigStore;
let state: ReturnType<typeof useStudioBootstrap>;
let actions: ReturnType<typeof useConfigActions>;
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value() { this.setAttribute("open", ""); } },
  close: { configurable: true, value() { this.removeAttribute("open"); } }
});
function Harness({ scope }: { scope: ConfigProfileScope }) {
  state = useStudioBootstrap("config");
  actions = useConfigActions({ ...state, linkedCompactModel: "synthetic", refreshHealthAfterWrite: async () => {} });
  return <><ProfileScopeCard scope={scope} config={state.config} title={scope} description="" emptyTitle="" emptyDescription=""
    profileName={scope === "codex" ? actions.profileName : actions.claudeProfileName}
    selectedProfileId={scope === "codex" ? actions.selectedProfileId : actions.selectedClaudeProfileId}
    profileState={scope === "codex" ? actions.profileState : actions.claudeProfileState}
    profileError={scope === "codex" ? actions.profileError : actions.claudeProfileError}
    onProfileNameChange={scope === "codex" ? actions.setProfileName : actions.setClaudeProfileName}
    onSelectedProfileChange={actions.selectConfigProfile} onSaveProfile={actions.saveConfigProfile}
    onApplyProfile={actions.applySelectedProfile} onUpdateProfile={actions.updateSelectedProfile}
    onReorderProfiles={actions.reorderProfiles} onDuplicateProfile={actions.duplicateSelectedProfile}
    onCreateProfileForOtherScope={() => {}} onDeleteProfile={actions.requestDeleteSelectedProfile} />
    <RouteConfigPanel config={state.config} form={state.form} onFormChange={state.setForm}
      scope={scope} onManageOAuth={() => {}} /></>;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  store?.oauth.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

for (const scope of ["codex", "claude"] as const) {
  it.each([[false, false], [false, true], [true, false], [true, true]] as const)(
    `protects existing active ${scope} profile while configLoaded=%s and editVisibleRoutes=%s`, async (configLoaded, editVisibleRoutes) => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const connection = { base_url: "https://synthetic.invalid/v1", api_key: "synthetic-key-only", api_key_env: "" };
    await store.patch(scope === "codex" ? { primary: connection } : { claude: { primary: connection } });
    await store.saveProfile(scope, "Existing", {});
    const existing = store.toPublicConfig().profile_scopes[scope].profiles[0];
    await store.applyProfile(scope, existing.id);
    const original = store.toPublicConfig();
    let write: Promise<Response> | undefined;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/health") return Response.json({ time: "synthetic" });
      if (url === "/api/oauth/accounts") return Response.json({ accounts: [] });
      if (url === "/api/config") return configLoaded ? Response.json(original)
        : Response.json({ error: "Synthetic config read failure" }, { status: 503 });
      if (url === "/api/config/profiles") {
        const sent = JSON.parse(String(init?.body));
        write = (async () => {
          try {
            if (init?.method === "POST") await store.saveProfile(sent.scope, sent.name, sent.config, sent.revision);
            else if (init?.method === "PATCH") await store.updateProfile(sent.scope, sent.profile_id, sent.name, sent.config, sent.revision);
            else throw new Error(`Unexpected method ${init?.method}`);
            return Response.json(store.toPublicConfig());
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
          }
        })();
        return write;
      }
      throw new Error(`Unexpected synthetic request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<StrictMode><Harness scope={scope} /></StrictMode>));
    expect(state.config === null).toBe(!configLoaded);
    await act(async () => host.querySelector<HTMLButtonElement>(".profile-new-button")!.click());
    const input = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Existing");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const draftUrl = "https://edited.synthetic.invalid/v1";
    if (editVisibleRoutes) await act(async () => {
      for (const routeInput of host.querySelectorAll<HTMLInputElement>('[aria-label="基础地址"]')) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(routeInput, draftUrl);
        routeInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const save = host.querySelector<HTMLButtonElement>(".profile-save-button")!;
    expect(save.disabled).toBe(!configLoaded);
    expect(save.textContent).toContain("为新档案");
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".profile-save-button")!.click();
      await write;
    });
    const current = store.toPublicConfig();
    const route = scope === "codex" ? current.primary : current.claude.primary;
    expect(current.profile_scopes[scope].profiles).toHaveLength(1);
    expect(current.profile_scopes[scope].active_profile_id).toBe(existing.id);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/config/profiles")).toHaveLength(0);
    if (configLoaded) {
      expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("覆盖会立即应用当前草稿");
    } else {
      for (const operation of ["save", "update"] as const) await act(async () => {
        expect(await (operation === "save" ? actions.saveConfigProfile(scope)
          : actions.updateSelectedProfile(scope, existing.id))).toBe(false);
      });
      expect(scope === "codex" ? actions.profileError : actions.claudeProfileError).toContain("配置尚未加载");
      expect(fetcher.mock.calls.filter(([url]) => url === "/api/config/profiles")).toHaveLength(0);
    }
    expect(route.base_url).toBe(connection.base_url);
  });
}
