// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import type { PublicConfig } from "../src/shared/types.js";
import {
  useLogStats, type AnalyticsPreset, type AnalyticsRange, type AnalyticsSnapshotCache
} from "../src/ui/analytics/analytics-data.js";
import { useStudioBootstrap } from "../src/ui/hooks/useStudioBootstrap.js";
import { formFromConfig } from "../src/ui/config/config-form-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const roots = new Set<Root>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.clear();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  const render = async (next: ReactNode) => { await act(async () => root.render(<StrictMode>{next}</StrictMode>)); };
  await render(node);
  return { container, render };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, json: (value: unknown) => resolve(Response.json(value)), reject };
}

function StatsHarness({ snapshot, preset, overview = false, view = "full", range }: {
  snapshot: React.RefObject<AnalyticsSnapshotCache<"full" | "usage"> | null>;
  preset: AnalyticsPreset;
  overview?: boolean;
  view?: "full" | "usage";
  range?: AnalyticsRange;
}) {
  const stats = useLogStats(range ?? preset, { snapshot, includeOverview: overview, view });
  return <>
    <output>{JSON.stringify({ sample: stats.data?.generated_at, loading: stats.loading, error: stats.error })}</output>
    <button onClick={stats.refresh}>refresh</button>
  </>;
}

function RetainedStats({ active = true, preset = "24h", overview = false, view, range }: {
  active?: boolean; preset?: AnalyticsPreset; overview?: boolean; view?: "full" | "usage"; range?: AnalyticsRange;
}) {
  const snapshot = useRef<AnalyticsSnapshotCache<"full" | "usage"> | null>(null);
  return active ? <StatsHarness snapshot={snapshot} preset={preset} overview={overview} view={view} range={range} /> : <span>away</span>;
}

function BootstrapHarness({ recoveryConfig }: { recoveryConfig?: PublicConfig }) {
  const state = useStudioBootstrap("config");
  return <>
    <output>{JSON.stringify({ config: state.config !== null, health: state.health !== null,
      error: state.pageError, failed: state.bootstrapFailed, draft: state.form.loggingKeepRecent,
      formRevision: state.formRevision, configRevision: state.config?.revision,
      savedModel: state.config?.primary.model_override, model: state.form.primaryModelOverride,
      healthTime: state.health?.time })}</output>
    <button onClick={state.retryBootstrap}>retry</button>
    <button onClick={() => state.setForm((form) => ({ ...form, loggingKeepRecent: 777 }))}>edit</button>
    {recoveryConfig && <button onClick={() => state.applyRemoteConfig(recoveryConfig)}>snapshot</button>}
    {recoveryConfig && <>
      <button onClick={() => { state.setConfig(recoveryConfig); state.setForm(formFromConfig(recoveryConfig)); }}>import</button>
      <button onClick={() => state.commitConfig(recoveryConfig, state.draftRevision)}>save</button>
      <button onClick={() => state.applyProfileConfig(recoveryConfig, "codex")}>apply profile</button>
    </>}
    <button onClick={state.notifyServerRecovered}>poll recovered</button>
    <button onClick={() => state.setPageError("export failed")}>operation error</button>
    <button onClick={() => state.setHealth((current) => current && { ...current, time: "newer-health" })}>new health</button>
  </>;
}

function state(container: HTMLElement) {
  return JSON.parse(container.querySelector("output")!.textContent!);
}
async function press(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await act(async () => button.click());
}
async function visibility(value: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}

describe("analytics snapshot lifecycle", () => {
  it("reuses a fresh snapshot across unmounts, expires at its sample age, and forces manual refresh", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ generated_at: "first" })));
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<RetainedStats />);
    expect(state(view.container)).toEqual({ sample: "first", loading: false, error: null });
    const initialRequests = fetcher.mock.calls.length;
    await view.render(<RetainedStats active={false} />);
    await act(async () => vi.advanceTimersByTime(30_000));
    await view.render(<RetainedStats />);
    expect(state(view.container).sample).toBe("first");
    expect(fetcher).toHaveBeenCalledTimes(initialRequests);
    const refresh = deferredResponse();
    fetcher.mockImplementation(() => refresh.promise.then((response) => response.clone()));
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(fetcher).toHaveBeenCalledTimes(initialRequests + 1);
    expect(state(view.container)).toEqual({ sample: "first", loading: true, error: null });
    await act(async () => refresh.json({ generated_at: "second" }));
    await press(view.container, "refresh");
    expect(fetcher).toHaveBeenCalledTimes(initialRequests + 2);
    await view.render(<RetainedStats active={false} />);
    const leftRequests = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(180_000));
    expect(fetcher).toHaveBeenCalledTimes(leftRequests);
  });

  it("retains stale data on failed refresh and never restores a different preset or overview", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ generated_at: "saved" })));
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<RetainedStats />);
    await view.render(<RetainedStats active={false} />);
    await act(async () => vi.advanceTimersByTime(60_000));
    const refresh = deferredResponse();
    fetcher.mockImplementation(() => refresh.promise.then((response) => response.clone()));
    await view.render(<RetainedStats />);
    expect(state(view.container)).toEqual({ sample: "saved", loading: true, error: null });
    await act(async () => refresh.reject(new Error("statistics unavailable")));
    expect(state(view.container)).toEqual({ sample: "saved", loading: false, error: "statistics unavailable" });
    await view.render(<RetainedStats active={false} />);
    fetcher.mockImplementation(() => new Promise(() => undefined));
    await view.render(<RetainedStats preset="7d" />);
    expect(state(view.container)).toEqual({ loading: true, error: null });
    await view.render(<RetainedStats active={false} />);
    await view.render(<RetainedStats overview />);
    expect(state(view.container)).toEqual({ loading: true, error: null });
    await view.render(<RetainedStats active={false} />);
    await view.render(<RetainedStats view="usage" />);
    expect(state(view.container)).toEqual({ loading: true, error: null });
    await view.render(<RetainedStats active={false} />);
    await view.render(<RetainedStats range={{ from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" }} />);
    expect(state(view.container)).toEqual({ loading: true, error: null });
  });

  it("cancels hidden and superseded requests, ignores their late results, and refreshes on visible resume", async () => {
    const pending: Array<{ signal: AbortSignal; response: ReturnType<typeof deferredResponse> }> = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      const response = deferredResponse();
      pending.push({ signal: init.signal as AbortSignal, response });
      return response.promise;
    }));
    const view = await mount(<RetainedStats />);
    const first = pending.at(-1)!;
    await view.render(<RetainedStats preset="7d" />);
    expect(first.signal.aborted).toBe(true);
    const second = pending.at(-1)!;
    await act(async () => first.response.json({ generated_at: "old" }));
    expect(state(view.container)).toEqual({ loading: true, error: null });
    await visibility("hidden");
    expect(second.signal.aborted).toBe(true);
    const count = pending.length;
    await act(async () => vi.advanceTimersByTime(180_000));
    expect(pending).toHaveLength(count);
    await act(async () => second.response.reject(new Error("stale failure")));
    expect(state(view.container).error).toBeNull();
    await visibility("visible");
    expect(pending).toHaveLength(count + 1);
    await act(async () => pending.at(-1)!.response.json({ generated_at: "current" }));
    expect(state(view.container)).toEqual({ sample: "current", loading: false, error: null });
  });

  it("clears an unrelated range error when returning to a fresh snapshot, without retaining more histories", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ generated_at: "saved" })));
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<RetainedStats />);
    fetcher.mockRejectedValue(new Error("range unavailable"));
    await view.render(<RetainedStats preset="7d" />);
    expect(state(view.container).error).toBe("range unavailable");
    const requests = fetcher.mock.calls.length;
    await view.render(<RetainedStats />);
    expect(state(view.container)).toEqual({ sample: "saved", loading: false, error: null });
    expect(fetcher).toHaveBeenCalledTimes(requests);
    fetcher.mockImplementation(() => Promise.resolve(Response.json({ generated_at: "newer range" })));
    await view.render(<RetainedStats preset="7d" />);
    await view.render(<RetainedStats active={false} />);
    fetcher.mockImplementation(() => new Promise(() => undefined));
    await view.render(<RetainedStats />);
    expect(state(view.container)).toEqual({ loading: true, error: null });
  });
});

describe("independent bootstrap requests", () => {
  it("keeps newer health when a failed retry has a late health response", async () => {
    const config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
    const fetcher = vi.fn((url: string) => Promise.resolve(Response.json(url === "/api/config" ? config : { time: "initial-health" })));
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<BootstrapHarness />);
    const requests = { config: deferredResponse(), health: deferredResponse() };
    fetcher.mockImplementation((url: string) => requests[url === "/api/config" ? "config" : "health"].promise);
    await press(view.container, "retry");
    await act(async () => requests.config.reject(new Error("config failed")));
    await press(view.container, "new health");
    await press(view.container, "poll recovered");
    await act(async () => requests.health.json({ time: "stale-health" }));
    expect(state(view.container)).toMatchObject({ healthTime: "newer-health", error: null });
  });

  it.each(["snapshot", "import", "save", "apply profile"])("keeps newer configuration from %s when an earlier bootstrap succeeds late", async (update) => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const old = store.toPublicConfig();
    const newer = structuredClone(old);
    newer.revision = "newer-configuration";
    newer.primary.model_override = "newer-model";
    const requests = { config: deferredResponse(), health: deferredResponse() };
    const fetcher = vi.fn((url: string) => requests[url === "/api/config" ? "config" : "health"].promise.then((response) => response.clone()));
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<BootstrapHarness recoveryConfig={newer} />);
    await act(async () => requests.health.reject(new Error("health failed")));
    await press(view.container, update);
    const updated = state(view.container);
    expect(updated).toMatchObject({ configRevision: newer.revision, formRevision: newer.revision, model: "newer-model" });
    await act(async () => requests.config.json(old));
    expect(state(view.container)).toEqual(updated);

    const retried = { ...newer, revision: "successful-retry" };
    fetcher.mockImplementation((url: string) => Promise.resolve(Response.json(url === "/api/config" ? retried : { ok: true })));
    await press(view.container, "retry");
    expect(state(view.container)).toMatchObject({ configRevision: retried.revision, formRevision: retried.revision, error: null });
  });

  it("preserves a dirty draft and its revision when a snapshot and stale retry resolve in one batch", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const old = store.toPublicConfig();
    const newer = structuredClone(old);
    newer.revision = "newer-configuration";
    newer.primary.model_override = "newer-model";
    const fetcher = vi.fn((url: string) => Promise.resolve(Response.json(url === "/api/config" ? old : { ok: true })));
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<BootstrapHarness recoveryConfig={newer} />);
    await press(view.container, "edit");
    const pending = deferredResponse();
    fetcher.mockImplementation((url: string) => url === "/api/config" ? pending.promise : Promise.resolve(Response.json({ ok: true })));
    await press(view.container, "retry");
    await act(async () => {
      [...view.container.querySelectorAll("button")].find((button) => button.textContent === "snapshot")!.click();
      pending.json(old);
    });
    expect(state(view.container)).toMatchObject({
      configRevision: newer.revision, savedModel: "newer-model", draft: 777, formRevision: old.revision
    });
  });

  it.each([
    ["config", "snapshot", true], ["health", "snapshot", true],
    ["config", "poll recovered", true], ["health", "poll recovered", true],
    ["config", "snapshot", false], ["health", "snapshot", false],
    ["config", "poll recovered", false], ["health", "poll recovered", false]
  ] as const)("does not revive a recovered %s failure after %s with sibling success=%s", async (failed, recovery, succeeds) => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = store.toPublicConfig();
    const requests = { config: deferredResponse(), health: deferredResponse() };
    vi.stubGlobal("fetch", vi.fn((url: string) => requests[url === "/api/config" ? "config" : "health"].promise.then((response) => response.clone())));
    const view = await mount(<BootstrapHarness recoveryConfig={config} />);
    await act(async () => requests[failed].reject(new Error(`${failed} failed`)));
    expect(state(view.container)).toMatchObject({ error: `${failed} failed`, failed: true });
    await press(view.container, recovery);
    expect(state(view.container)).toMatchObject({ error: null, failed: false });
    const sibling = failed === "config" ? "health" : "config";
    await act(async () => {
      if (succeeds) requests[sibling].json(sibling === "config" ? config : { ok: true });
      else requests[sibling].reject(new Error(`${sibling} failed late`));
    });
    expect(state(view.container)).toMatchObject({ error: null, failed: false });
    if (succeeds) expect(state(view.container)[sibling]).toBe(true);
  });

  it.each(["snapshot", "poll recovered"])("ignores both old failures when %s arrives before either result in the same batch", async (recovery) => {
    const config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
    const requests = { config: deferredResponse(), health: deferredResponse() };
    const fetcher = vi.fn((url: string) => requests[url === "/api/config" ? "config" : "health"].promise);
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<BootstrapHarness recoveryConfig={config} />);
    await act(async () => {
      [...view.container.querySelectorAll("button")].find((button) => button.textContent === recovery)!.click();
      requests.config.reject(new Error("old config failure"));
      requests.health.reject(new Error("old health failure"));
    });
    expect(state(view.container)).toMatchObject({ error: null, failed: false });

    fetcher.mockImplementation((url: string) => Promise.reject(new Error(`new failure ${url}`)));
    await press(view.container, "retry");
    expect(state(view.container)).toMatchObject({ failed: true });
    expect(state(view.container).error).toContain("new failure /api/config");
    expect(state(view.container).error).toContain("new failure /api/health");
    fetcher.mockImplementation((url: string) => Promise.resolve(Response.json(url === "/api/config" ? config : { time: "recovered" })));
    await press(view.container, "retry");
    expect(state(view.container)).toMatchObject({ config: true, health: true, error: null, failed: false });
  });

  it.each([true, false])("preserves a newer operation error after bootstrap failure with sibling success=%s", async (succeeds) => {
    const config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
    const requests = { config: deferredResponse(), health: deferredResponse() };
    vi.stubGlobal("fetch", vi.fn((url: string) => requests[url === "/api/config" ? "config" : "health"].promise));
    const view = await mount(<BootstrapHarness recoveryConfig={config} />);
    await act(async () => requests.health.reject(new Error("health failed")));
    await press(view.container, "operation error");
    await act(async () => {
      if (succeeds) requests.config.json(config);
      else requests.config.reject(new Error("late config failure"));
    });
    await press(view.container, "snapshot");
    await press(view.container, "poll recovered");
    expect(state(view.container)).toMatchObject({ error: "export failed", failed: false });
  });

  it("does not clear a new operation error when both older bootstrap requests succeed", async () => {
    const config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
    const requests = { config: deferredResponse(), health: deferredResponse() };
    vi.stubGlobal("fetch", vi.fn((url: string) => requests[url === "/api/config" ? "config" : "health"].promise.then((response) => response.clone())));
    const view = await mount(<BootstrapHarness />);
    await act(async () => requests.config.json(config));
    await press(view.container, "operation error");
    await act(async () => requests.health.json({ time: "health" }));
    expect(state(view.container)).toMatchObject({ error: "export failed", failed: false });
  });

  it.each(["config", "health"] as const)("renders %s without waiting for the other request and preserves the other error", async (first) => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = store.toPublicConfig();
    const requests = { config: deferredResponse(), health: deferredResponse() };
    vi.stubGlobal("fetch", vi.fn((url: string) => requests[url === "/api/config" ? "config" : "health"].promise.then((response) => response.clone())));
    const view = await mount(<BootstrapHarness />);
    const second = first === "config" ? "health" : "config";
    await act(async () => requests[first].json(first === "config" ? config : { ok: true }));
    expect(state(view.container)).toMatchObject({ [first]: true, [second]: false, error: null });
    await act(async () => requests[second].reject(new Error(`${second} failed`)));
    expect(state(view.container)).toMatchObject({ [first]: true, error: `${second} failed`, failed: true });
  });

  it("does not clear a sibling error when the other request succeeds later, and aborts retry predecessors", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = store.toPublicConfig();
    const requests: Array<{ url: string; signal: AbortSignal; response: ReturnType<typeof deferredResponse> }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      const response = deferredResponse();
      requests.push({ url, signal: init.signal as AbortSignal, response });
      return response.promise;
    }));
    const view = await mount(<BootstrapHarness />);
    const latest = (url: string) => [...requests].reverse().find((item) => item.url === url)!;
    await act(async () => latest("/api/health").response.reject(new Error("health failed")));
    await act(async () => latest("/api/config").response.json(config));
    expect(state(view.container)).toMatchObject({ config: true, health: false, error: "health failed", failed: true });
    await press(view.container, "edit");
    const staleConfig = latest("/api/config");
    await press(view.container, "retry");
    expect(staleConfig.signal.aborted).toBe(true);
    await act(async () => latest("/api/config").response.json(config));
    expect(state(view.container).draft).toBe(777);
    await act(async () => latest("/api/health").response.json({ ok: true }));
    expect(state(view.container)).toMatchObject({ config: true, health: true, error: null, failed: false, draft: 777 });
  });
});
