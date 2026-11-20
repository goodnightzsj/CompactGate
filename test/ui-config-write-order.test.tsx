// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { isFormDirty } from "../src/ui/config/config-form-state.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { useStudioBootstrap } from "../src/ui/hooks/useStudioBootstrap.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

let root: Root | undefined;
let state: ReturnType<typeof useStudioBootstrap>;
let actions: ReturnType<typeof useConfigActions>;
function Harness() {
  state = useStudioBootstrap("config");
  actions = useConfigActions({ ...state, linkedCompactModel: "synthetic", refreshHealthAfterWrite: async () => {} });
  return null;
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

async function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  await store.saveProfile("codex", "Alpha", {});
  await store.saveProfile("codex", "Beta", {});
  const ids = store.toPublicConfig().profile_scopes.codex.profiles.map(profile => profile.id);
  await store.applyProfile("codex", ids[0]);
  const original = store.toPublicConfig();
  await store.patch({ logging: { keep_recent: 250 }, primary: { model_override: "saved" } });
  const ours = store.toPublicConfig();
  await store.patch({ logging: { keep_recent: 300 }, primary: { model_override: "newer" } });
  const newer = store.toPublicConfig();
  const write = deferred();
  const read = deferred();
  let reloading = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ time: "synthetic" });
    if (!init?.method && url === "/api/config") return reloading ? read.promise : Response.json(original);
    return write.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
  reloading = true;
  return { original, ours, newer, ids, write, read, fetchMock };
}

for (const scope of ["codex", "claude"] as const) {
  it.each(["write", "reconcile", "deleted"] as const)(
    `preserves the current ${scope} selection and rename after sorting: %s`, async stage => {
      vi.useFakeTimers();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
      await store.saveProfile(scope, "Alpha", {});
      await store.saveProfile(scope, "Beta", {});
      const [alpha, beta] = store.toPublicConfig().profile_scopes[scope].profiles.map(profile => profile.id);
      await store.applyProfile(scope, alpha);
      const original = store.toPublicConfig();
      await store.reorderProfiles(scope, [beta, alpha]);
      const ours = store.toPublicConfig();
      await store.patch({ logging: { keep_recent: 250 } });
      const newer = store.toPublicConfig();
      const write = deferred();
      const read = deferred();
      let reloading = false;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/health") return Response.json({ time: "synthetic" });
        if (url === "/api/config" && !init?.method) return reloading ? read.promise : Response.json(original);
        return write.promise;
      });
      vi.stubGlobal("fetch", fetchMock);
      root = createRoot(document.createElement("div"));
      await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
      reloading = true;
      await act(async () => actions.selectConfigProfile(scope, alpha));
      let request!: Promise<void>;
      await act(async () => { request = actions.reorderProfiles(scope, [beta, alpha]); });
      const readsBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/config").length;
      if (stage !== "write") {
        await act(async () => state.applyRemoteConfig(newer));
        await act(async () => write.resolve(Response.json(ours)));
        expect(fetchMock.mock.calls.filter(([url]) => url === "/api/config")).toHaveLength(readsBefore + 1);
      }
      expect(scope === "codex" ? actions.profileState : actions.claudeProfileState).toBe("reordering");
      await act(async () => actions.selectConfigProfile(scope, beta));
      await act(async () => (scope === "codex" ? actions.setProfileName : actions.setClaudeProfileName)("Beta draft"));
      if (stage === "deleted") await store.deleteProfile(scope, beta);
      const latest = stage === "write" ? ours : stage === "deleted" ? store.toPublicConfig() : newer;
      await act(async () => {
        if (stage === "write") write.resolve(Response.json(ours));
        else read.resolve(Response.json(latest));
        await request;
      });
      expect(state.config).toEqual(latest);
      expect(scope === "codex" ? actions.selectedProfileId : actions.selectedClaudeProfileId)
        .toBe(stage === "deleted" ? alpha : beta);
      expect(scope === "codex" ? actions.profileName : actions.claudeProfileName)
        .toBe(stage === "deleted" ? "Alpha" : "Beta draft");
      expect(scope === "codex" ? actions.profileState : actions.claudeProfileState).toBe("reordered");
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/config"))
        .toHaveLength(readsBefore + (stage === "write" ? 0 : 1));
    }
  );
}

it.each(["save", "import", "profile-save", "profile-update", "apply", "duplicate", "reorder", "delete", "oauth"] as const)(
  "keeps a newer SSE baseline and in-flight edits after a late %s response", async operation => {
    const { original, ours, newer, ids, write, read } = await setup();
    await act(async () => state.setForm(form => ({ ...form, primaryModelOverride: "saved", loggingKeepRecent: 250 })));
    if (operation === "delete") await act(async () => actions.requestDeleteSelectedProfile("codex", ids[1]));
    let request!: Promise<unknown> | void;
    await act(async () => {
      if (operation === "save") request = actions.saveConfig({ preventDefault() {} } as FormEvent);
      else if (operation === "import") request = actions.importConfig({});
      else if (operation === "profile-save") request = actions.saveConfigProfile("codex", "Alpha");
      else if (operation === "profile-update") request = actions.updateSelectedProfile("codex", ids[0]);
      else if (operation === "apply") request = actions.applySelectedProfile("codex", ids[1]);
      else if (operation === "duplicate") request = actions.duplicateSelectedProfile("codex", ids[0]);
      else if (operation === "reorder") request = actions.reorderProfiles("codex", [...ids].reverse());
      else if (operation === "delete") request = actions.confirmDeleteSelectedProfile();
    });
    // The OAuth panel captures its callback before starting its own HTTP request.
    const receiveOAuthConfig = actions.receiveOAuthConfig;
    await act(async () => state.applyRemoteConfig(ours));
    await act(async () => state.applyRemoteConfig(newer));
    expect(state.config?.revision).toBe(newer.revision);
    expect(isFormDirty(newer, state.form)).toBe(false);
    await act(async () => state.setForm(form => ({ ...form, loggingKeepRecent: 999 })));
    const draftRevision = state.formRevision;
    await act(async () => {
      if (operation === "oauth") request = receiveOAuthConfig(ours);
      else write.resolve(Response.json(ours));
    });
    await act(async () => { read.resolve(Response.json(newer)); await request; });
    expect(state.config).toEqual(newer);
    expect(state.form.primaryModelOverride).toBe("newer");
    expect(state.form.loggingKeepRecent).toBe(999);
    expect(state.formRevision).toBe(draftRevision);
    expect(state.config?.revision).not.toBe(original.revision);
  }
);

it.each([false, true])("accepts a current import after an intervening snapshot, read overtaken=%s", async overtaken => {
  const { original, ours, newer, write, read } = await setup();
  await act(async () => state.setForm(form => ({ ...form, primaryModelOverride: "replace-draft" })));
  let request!: Promise<void>;
  await act(async () => { request = actions.importConfig({}); });
  await act(async () => state.applyRemoteConfig({ ...original, revision: "opaque-intervening" }));
  await act(async () => write.resolve(Response.json(ours)));
  if (overtaken) await act(async () => state.applyRemoteConfig(newer));
  await act(async () => { read.resolve(Response.json(ours)); await request; });
  expect(state.config).toEqual(overtaken ? newer : ours);
  expect(state.form.primaryModelOverride).toBe(overtaken ? "replace-draft" : "saved");
});

it.each([false, true])("commits a current import without an extra read, own snapshot first=%s", async snapshotFirst => {
  const { ours, write, fetchMock } = await setup();
  const reads = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/config" && !init?.method).length;
  const before = reads();
  let request!: Promise<void>;
  await act(async () => { request = actions.importConfig({}); });
  if (snapshotFirst) await act(async () => state.applyRemoteConfig(ours));
  await act(async () => { write.resolve(Response.json(ours)); await request; });
  expect(state.config).toEqual(ours);
  expect(isFormDirty(ours, state.form)).toBe(false);
  expect(reads()).toBe(before);
});

it.each([false, true])("reconciles a snapshot in the same React batch as a write, write still current=%s", async current => {
  const { original, ours, newer, write, read } = await setup();
  let request!: Promise<void>;
  await act(async () => { request = actions.importConfig({}); });
  await act(async () => {
    state.applyRemoteConfig(current ? { ...original, revision: "opaque-intervening" } : newer);
    write.resolve(Response.json(ours));
    read.resolve(Response.json(current ? ours : newer));
    await request;
  });
  expect(state.config).toEqual(current ? ours : newer);
  expect(isFormDirty(state.config!, state.form)).toBe(false);
});

it("reports a failed reconciliation without undoing the successful write or newer snapshot", async () => {
  const { ours, newer, write, read } = await setup();
  let request!: Promise<void>;
  await act(async () => { request = actions.importConfig({}); });
  const result = request.then(() => null, error => error);
  await act(async () => state.applyRemoteConfig(newer));
  await act(async () => write.resolve(Response.json(ours)));
  await act(async () => { read.resolve(Response.json({ error: "Synthetic refresh failure" }, { status: 503 })); await result; });
  expect(await result).toMatchObject({ message: "配置已写入，但最新配置刷新失败：Synthetic refresh failure" });
  expect(state.config).toEqual(newer);
});

for (const operation of ["save", "import"] as const) {
  it.each(["reload-first", "write-first", "render-between"] as const)(
    `keeps a successful ${operation} when bootstrap overlaps: %s`, async order => {
      const { original, ours, write, read, fetchMock } = await setup();
      await act(async () => state.setForm(form => ({ ...form, primaryModelOverride: "saved", loggingKeepRecent: 250 })));
      let request!: Promise<void>;
      await act(async () => {
        request = operation === "save" ? actions.saveConfig({ preventDefault() {} } as FormEvent) : actions.importConfig({});
      });
      await act(async () => state.retryBootstrap());
      const readsBefore = fetchMock.mock.calls.filter(([url, init]) => url === "/api/config" && !init?.method).length;
      fetchMock.mockImplementation(async url => Response.json(url === "/api/health" ? { time: "synthetic" } : ours));
      if (order === "render-between") await act(async () => read.resolve(Response.json(original)));
      await act(async () => {
        if (order === "reload-first") read.resolve(Response.json(original));
        write.resolve(Response.json(ours));
        if (order === "write-first") read.resolve(Response.json(original));
        await request;
      });
      expect(state.config).toEqual(ours);
      expect(state.form.primaryModelOverride).toBe("saved");
      expect(state.formRevision).toBe(ours.revision);
      expect(isFormDirty(ours, state.form)).toBe(false);
      expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/config" && !init?.method)).toHaveLength(readsBefore);
    }
  );
}

it.each([false, true])("reconciles a changed bootstrap revision before a batched write, write current=%s", async current => {
  const { original, ours, newer, write, read, fetchMock } = await setup();
  await act(async () => state.setForm(form => ({ ...form, primaryModelOverride: "local-draft" })));
  let request!: Promise<void>;
  await act(async () => { request = actions.importConfig({}); });
  await act(async () => state.retryBootstrap());
  const readsBefore = fetchMock.mock.calls.filter(([url, init]) => url === "/api/config" && !init?.method).length;
  fetchMock.mockImplementation(async url => Response.json(url === "/api/health" ? { time: "synthetic" } : current ? ours : newer));
  await act(async () => {
    read.resolve(Response.json(current ? { ...original, revision: "opaque-intervening" } : newer));
    write.resolve(Response.json(ours));
    await request;
  });
  expect(state.config).toEqual(current ? ours : newer);
  expect(state.form.primaryModelOverride).toBe(current ? "saved" : "local-draft");
  expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/config" && !init?.method)).toHaveLength(readsBefore + 1);
});
