// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import type { ConfigProfileScope } from "../src/shared/types.js";
import { ProfileScopeCard } from "../src/ui/config/ProfileScopeCard.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { useStudioBootstrap } from "../src/ui/hooks/useStudioBootstrap.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

let root: Root | undefined;
let host: HTMLDivElement;
let state: ReturnType<typeof useStudioBootstrap>;
let actions: ReturnType<typeof useConfigActions>;

function Harness() {
  state = useStudioBootstrap("config");
  actions = useConfigActions({ ...state, linkedCompactModel: "synthetic", refreshHealthAfterWrite: async () => {} });
  return <>{(["codex", "claude"] as const).map(scope => <ProfileScopeCard key={scope} scope={scope}
    config={state.config} title={scope} description="" emptyTitle="" emptyDescription=""
    profileName={scope === "codex" ? actions.profileName : actions.claudeProfileName}
    selectedProfileId={scope === "codex" ? actions.selectedProfileId : actions.selectedClaudeProfileId}
    profileState={scope === "codex" ? actions.profileState : actions.claudeProfileState}
    profileError={scope === "codex" ? actions.profileError : actions.claudeProfileError}
    onProfileNameChange={scope === "codex" ? actions.setProfileName : actions.setClaudeProfileName}
    onSelectedProfileChange={actions.selectConfigProfile} onSaveProfile={actions.saveConfigProfile}
    onApplyProfile={actions.applySelectedProfile} onUpdateProfile={actions.updateSelectedProfile}
    onReorderProfiles={actions.reorderProfiles} onDuplicateProfile={actions.duplicateSelectedProfile}
    onCreateProfileForOtherScope={() => {}} onDeleteProfile={actions.requestDeleteSelectedProfile} />)}</>;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(scope: ConfigProfileScope) {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  await store.saveProfile(scope, "Alpha", {});
  await store.saveProfile(scope, "Beta", {});
  const [alpha, beta] = store.toPublicConfig().profile_scopes[scope].profiles;
  await store.applyProfile(scope, beta.id);
  const original = store.toPublicConfig();
  const write = deferred();
  const read = deferred();
  let reloading = false;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ time: "synthetic" });
    if (url === "/api/config" && !init?.method) return reloading ? read.promise : Response.json(original);
    return write.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
  reloading = true;
  return { store, alpha, beta, original, write, read, fetchMock };
}

function card(scope: ConfigProfileScope) {
  return host.querySelector<HTMLElement>(`.profile-card-${scope}`)!;
}

async function select(scope: ConfigProfileScope, name: string) {
  const button = [...card(scope).querySelectorAll<HTMLButtonElement>(".profile-item-main")]
    .find(item => item.querySelector("strong")?.textContent === name)!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}

async function rename(scope: ConfigProfileScope, name: string) {
  const input = card(scope).querySelector<HTMLInputElement>("input")!;
  expect(input.disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe(name);
}

function selection(scope: ConfigProfileScope) {
  return {
    name: card(scope).querySelector<HTMLInputElement>("input")!.value,
    profile: card(scope).querySelector('.profile-item-main[aria-pressed="true"] strong')?.textContent ?? null
  };
}

for (const scope of ["codex", "claude"] as const) {
  it.each(["round-trip-write", "round-trip-reconcile", "rename", "unchanged"] as const)(
    `new profile ${scope} preserves later selection and drafts: %s`, async scenario => {
      const { store, beta, write, read, fetchMock } = await setup(scope);
      await select(scope, "Alpha");
      const create = card(scope).querySelector<HTMLButtonElement>(".profile-new-button")!;
      expect(create.disabled).toBe(false);
      await act(async () => create.click());
      await rename(scope, "Created");
      const save = card(scope).querySelector<HTMLButtonElement>(".profile-save-button")!;
      expect(save.disabled).toBe(false);
      await act(async () => save.click());
      const [url, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
      expect(url).toBe("/api/config/profiles");
      const sent = JSON.parse(String(init?.body));
      expect(sent).toMatchObject({ scope, name: "Created" });
      await store.saveProfile(scope, sent.name, sent.config, sent.revision);
      const saved = store.toPublicConfig();
      const reconcile = scenario === "round-trip-reconcile";
      if (reconcile) {
        const readsBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/config").length;
        await store.patch({ logging: { keep_recent: 250 } });
        await act(async () => state.applyRemoteConfig(store.toPublicConfig()));
        await act(async () => write.resolve(Response.json(saved)));
        expect(fetchMock.mock.calls.filter(([url]) => url === "/api/config")).toHaveLength(readsBefore + 1);
      }
      const roundTrip = scenario.startsWith("round-trip");
      if (roundTrip) {
        await select(scope, "Beta");
        await select(scope, "Alpha");
        expect(selection(scope)).toEqual({ profile: "Alpha", name: "Alpha" });
      } else if (scenario === "rename") await rename(scope, "Newer draft");
      const latest = store.toPublicConfig();
      if (!reconcile) await act(async () => state.applyRemoteConfig(latest));
      await act(async () => (reconcile ? read : write).resolve(Response.json(latest)));
      expect(state.config).toEqual(latest);
      expect(latest.profile_scopes[scope].profiles.some(profile => profile.name === "Created")).toBe(true);
      expect(latest.profile_scopes[scope].active_profile_id).toBe(beta.id);
      expect(selection(scope)).toEqual(roundTrip ? { profile: "Alpha", name: "Alpha" }
        : { profile: "Created", name: scenario === "rename" ? "Newer draft" : "Created" });
    }
  );

  for (const operation of ["apply", "duplicate"] as const) {
    it.each(["select-write", "select-reconcile", "rename", "unchanged", "unselected", "rejected"] as const)(
      `${operation} ${scope} preserves selection and rename: %s`, async scenario => {
        const { store, alpha, beta, original, write, read, fetchMock } = await setup(scope);
        if (scenario !== "unselected") await select(scope, "Alpha");
        const row = [...card(scope).querySelectorAll("article")].find(item => item.textContent?.includes("Alpha"))!;
        const button = operation === "apply" ? row.querySelector<HTMLButtonElement>(".profile-apply-button")!
          : [...row.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "复制档案")!;
        expect(button.disabled).toBe(false);
        await act(async () => button.click());
        expect(selection(scope)).toEqual({ profile: "Alpha", name: "Alpha" });
        const sent = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
        expect(sent[0]).toBe(`/api/config/profiles/${operation}`);
        expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ scope, profile_id: alpha.id });
        if (scenario !== "rejected") {
          if (operation === "apply") await store.applyProfile(scope, alpha.id);
          else await store.duplicateProfile(scope, alpha.id, "Alpha copy");
        }
        const ours = store.toPublicConfig();
        const readsBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/config").length;
        if (scenario === "select-reconcile") {
          await store.patch({ logging: { keep_recent: 250 } });
          await act(async () => state.applyRemoteConfig(store.toPublicConfig()));
          await act(async () => write.resolve(Response.json(ours)));
          expect(fetchMock.mock.calls.filter(([url]) => url === "/api/config")).toHaveLength(readsBefore + 1);
        }
        const changedSelection = scenario.startsWith("select") || scenario === "rejected";
        if (changedSelection) await select(scope, "Beta");
        if (changedSelection || scenario === "rename") await rename(scope, "Edited during request");
        await act(async () => {
          if (scenario === "select-reconcile") read.resolve(Response.json(store.toPublicConfig()));
          else write.resolve(scenario === "rejected"
            ? Response.json({ error: "Synthetic failure" }, { status: 409 }) : Response.json(ours));
        });
        expect(state.config).toEqual(scenario === "rejected" ? original : store.toPublicConfig());
        expect(state.config?.profile_scopes[scope].active_profile_id)
          .toBe(operation === "apply" && scenario !== "rejected" ? alpha.id : beta.id);
        const expectedProfile = changedSelection ? "Beta"
          : operation === "duplicate" && scenario !== "rename" ? "Alpha copy" : "Alpha";
        expect(selection(scope)).toEqual({ profile: expectedProfile,
          name: changedSelection || scenario === "rename" ? "Edited during request" : expectedProfile });
        expect(scope === "codex" ? actions.profileState : actions.claudeProfileState)
          .toBe(scenario === "rejected" ? "error" : operation === "apply" ? "applied" : "duplicated");
      }
    );
  }

  for (const interaction of ["selection", "rename"] as const) {
    it.each(["write", "reconcile"] as const)(
      `duplicate ${scope} preserves ${interaction} round trips while awaiting %s`, async waitingFor => {
        const { store, alpha, beta, write, read, fetchMock } = await setup(scope);
        await select(scope, "Alpha");
        const row = [...card(scope).querySelectorAll("article")].find(item => item.textContent?.includes("Alpha"))!;
        const more = row.querySelector<HTMLDetailsElement>("details")!;
        await act(async () => more.querySelector<HTMLElement>("summary")!.click());
        expect(more.open).toBe(true);
        const copy = [...row.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "复制档案")!;
        expect(copy.disabled).toBe(false);
        await act(async () => copy.click());
        await store.duplicateProfile(scope, alpha.id, "Alpha copy");
        const ours = store.toPublicConfig();
        if (waitingFor === "reconcile") {
          const readsBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/config").length;
          await store.patch({ logging: { keep_recent: 250 } });
          await act(async () => state.applyRemoteConfig(store.toPublicConfig()));
          await act(async () => write.resolve(Response.json(ours)));
          expect(fetchMock.mock.calls.filter(([url]) => url === "/api/config")).toHaveLength(readsBefore + 1);
        }
        if (interaction === "selection") {
          await select(scope, "Beta");
          await select(scope, "Alpha");
        } else {
          await rename(scope, "Edited during request");
          await rename(scope, "Alpha");
        }
        expect(selection(scope)).toEqual({ profile: "Alpha", name: "Alpha" });
        await act(async () => (waitingFor === "reconcile" ? read : write).resolve(Response.json(store.toPublicConfig())));
        expect(state.config).toEqual(store.toPublicConfig());
        expect(state.config?.profile_scopes[scope].profiles.some(profile => profile.name === "Alpha copy")).toBe(true);
        expect(state.config?.profile_scopes[scope].active_profile_id).toBe(beta.id);
        expect(selection(scope)).toEqual({ profile: "Alpha", name: "Alpha" });
        expect(scope === "codex" ? actions.profileState : actions.claudeProfileState).toBe("duplicated");
      }
    );
  }

  it.each(["unchanged", "rename", "empty"] as const)(`copies into ${scope} without changing the source draft: %s`, async scenario => {
    const { store, write } = await setup(scope);
    const sourceScope = scope === "codex" ? "claude" : "codex";
    await store.saveProfile(sourceScope, "Source", {});
    const sourceId = store.toPublicConfig().profile_scopes[sourceScope].profiles[0].id;
    if (scenario === "empty") {
      for (const profile of store.toPublicConfig().profile_scopes[scope].profiles) await store.deleteProfile(scope, profile.id);
    }
    await act(async () => state.applyRemoteConfig(store.toPublicConfig()));
    await rename(sourceScope, "Source draft");
    let request!: Promise<boolean>;
    await act(async () => { request = actions.duplicateSelectedProfile(sourceScope, sourceId, { targetScope: scope, name: "Cross copy" }); });
    if (scenario === "rename") await rename(scope, "Target draft");
    await store.duplicateProfile(sourceScope, sourceId, "Cross copy", scope);
    const latest = store.toPublicConfig();
    // The first target profile may arrive through SSE before its HTTP response.
    await act(async () => state.applyRemoteConfig(latest));
    await act(async () => { write.resolve(Response.json(latest)); expect(await request).toBe(true); });
    expect(selection(sourceScope)).toEqual({ profile: "Source", name: "Source draft" });
    expect(selection(scope)).toEqual(scenario === "rename"
      ? { profile: "Beta", name: "Target draft" } : { profile: "Cross copy", name: "Cross copy" });
    expect(state.config).toEqual(latest);
  });
}
