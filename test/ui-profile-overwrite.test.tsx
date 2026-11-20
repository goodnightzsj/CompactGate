// @vitest-environment jsdom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { ProfileScopeCard } from "../src/ui/config/ProfileScopeCard.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { useStudioBootstrap } from "../src/ui/hooks/useStudioBootstrap.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

async function setup() {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  await store.saveProfile("codex", "Live", {});
  const profile = store.toPublicConfig().profile_scopes.codex.profiles[0];
  await store.applyProfile("codex", profile.id);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ time: "synthetic" });
    if (url === "/api/config") return Response.json(store.toPublicConfig());
    if (url === "/api/config/profiles") {
      const sent = JSON.parse(String(init?.body));
      if (init?.method === "PATCH") await store.updateProfile(sent.scope, sent.profile_id, sent.name, sent.config, sent.revision);
      else await store.saveProfile(sent.scope, sent.name, sent.config, sent.revision);
      return Response.json(store.toPublicConfig());
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  let state!: ReturnType<typeof useStudioBootstrap>;
  let actions!: ReturnType<typeof useConfigActions>;
  function Harness() {
    state = useStudioBootstrap("config");
    actions = useConfigActions({ ...state, linkedCompactModel: "synthetic", refreshHealthAfterWrite: async () => {} });
    return <ProfileScopeCard scope="codex" config={state.config} title="Codex" description="" emptyTitle="" emptyDescription=""
      profileName={actions.profileName} selectedProfileId={actions.selectedProfileId}
      profileState={actions.profileState} profileError={actions.profileError}
      onProfileNameChange={actions.setProfileName} onSelectedProfileChange={actions.selectConfigProfile}
      onSaveProfile={actions.saveConfigProfile} onApplyProfile={actions.applySelectedProfile}
      onUpdateProfile={actions.updateSelectedProfile} onReorderProfiles={actions.reorderProfiles}
      onDuplicateProfile={actions.duplicateSelectedProfile} onCreateProfileForOtherScope={() => {}}
      onDeleteProfile={actions.requestDeleteSelectedProfile} />;
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  return { store, profile, fetcher, host, get state() { return state; }, get actions() { return actions; },
    async cleanup() { await act(async () => root.unmount()); host.remove(); store.oauth.close(); vi.unstubAllGlobals(); } };
}

it("warns that overwriting an active profile from new-profile mode applies the draft immediately", async () => {
  const ctx = await setup();
  try {
    await act(async () => ctx.state.setForm(current => ({ ...current, primaryModelOverride: "draft-new-model" })));
    await act(async () => ctx.host.querySelector<HTMLButtonElement>(".profile-new-button")!.click());
    await act(async () => ctx.actions.setProfileName("Live"));
    await act(async () => ctx.host.querySelector<HTMLButtonElement>(".profile-save-button")!.click());
    const dialog = ctx.host.querySelector("dialog")!;
    const warning = dialog.querySelector("#confirm-profile-overwrite-desc")!.textContent!;
    expect(warning).not.toContain("不会切换当前运行时");
    expect(dialog.querySelector(".danger-solid-button")!.textContent).toContain("覆盖并立即应用");
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>(".danger-solid-button")!.click();
      // The endpoint contract applies writes to an active profile immediately.
      await vi.waitFor(() => expect(ctx.store.toPublicConfig().primary.model_override).toBe("draft-new-model"));
    });
    expect(warning).toMatch(/立即应用|更新当前运行时|修改当前运行时/);
  } finally { await ctx.cleanup(); }
});
