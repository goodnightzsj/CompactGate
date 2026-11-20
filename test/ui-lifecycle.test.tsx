// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import type { ConfigProfileScope, PublicConfig, RequestLogEntry, RequestLogPage } from "../src/shared/types.js";
import { useStudioPageModels } from "../src/ui/app/useStudioPageModels.js";
import { ConfigPreviewPanel } from "../src/ui/config/ConfigPreviewPanel.js";
import { ConfigPage } from "../src/ui/config/ConfigPage.js";
import { useUpstreamModels } from "../src/ui/config/useUpstreamModels.js";
import { useLogFeed } from "../src/ui/hooks/useLogFeed.js";
import { emptyLogPage } from "../src/ui/logs/log-utils.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const roots = new Set<Root>();
const noop = () => undefined;
class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  closed = false;
  constructor(readonly url: string) { super(); TestEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(type: string, payload?: unknown) {
    this.dispatchEvent(payload === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(payload) }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { matches: true, media }));
  TestEventSource.instances = [];
});

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.clear();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  const render = async (next: ReactNode) => { await act(async () => root.render(<StrictMode>{next}</StrictMode>)); };
  await render(node);
  return { container, render, unmount: async () => { await act(async () => root.unmount()); roots.delete(root); } };
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, json: (value: unknown) => resolve(Response.json(value)), reject };
}

function ProfileHarness({ scope }: { scope: ConfigProfileScope }) {
  const { pageOutlet: { configPage } } = useStudioPageModels({
    currentPage: "config", configTab: "profiles", healthMode: false, pageMode: "config", onConfigTabChange: noop
  });
  const { actions, form, onFormChange } = configPage;
  const setName = scope === "codex" ? actions.setProfileName : actions.setClaudeProfileName;
  return <>
    <output data-name>{scope === "codex" ? actions.profileName : actions.claudeProfileName}</output>
    <output data-selected>{scope === "codex" ? actions.selectedProfileId : actions.selectedClaudeProfileId}</output>
    <output data-draft>{form.loggingKeepRecent}</output>
    <button onClick={() => setName("Submitted")}>draft</button>
    <button onClick={() => { setName("Newer edit"); onFormChange((current) => ({ ...current, loggingKeepRecent: 777 })); }}>edit again</button>
    <button onClick={() => void actions.saveConfigProfile(scope)}>save</button>
  </>;
}

function ModelsHarness({ source }: { source: string }) {
  const catalogue = useUpstreamModels("/api/openai/models", source);
  return <>
    <output>{JSON.stringify({ state: catalogue.fetchState, models: catalogue.models, meta: catalogue.fetchMeta })}</output>
    <button onClick={() => void catalogue.fetchModels()}>load</button>
  </>;
}

function LogsHarness() {
  const feed = useLogFeed({ enabled: true, filterLogs: true, hasConfig: true, logPageLimit: 2,
    applyRemoteConfig: noop, onServerRecovered: noop, setHealth: noop, setCodexStatus: noop });
  return <>
    <output>{JSON.stringify({ ids: feed.logPage.logs.map((entry) => entry.request_id), total: feed.logPage.total,
      loading: feed.isLoadingLogs, more: feed.isLoadingMoreLogs, stale: feed.hasStaleLogs, error: feed.logError })}</output>
    <button onClick={() => void feed.loadMoreLogs()}>more</button>
    <button onClick={() => feed.setRouteFilter("compact")}>compact</button>
    <button onClick={() => feed.setRouteFilter("primary")}>primary</button>
    <button onClick={() => feed.setSearchFilter(previous => `${previous}x`)}>type next</button>
    <button onClick={() => feed.setSearchFilter("")}>clear search</button>
  </>;
}

function renderedState(container: HTMLElement) {
  return JSON.parse(container.querySelector("output")!.textContent!);
}

function HealthHarness({ healthMode, metadataConfig }: { healthMode: boolean; metadataConfig?: PublicConfig }) {
  const { pageOutlet, sidebarHealth } = useStudioPageModels({
    currentPage: healthMode ? "health" : "dashboard", configTab: "profiles", healthMode,
    pageMode: healthMode ? "health" : "dashboard", onConfigTabChange: noop
  });
  return <>
    <output>{JSON.stringify({ healthTime: sidebarHealth?.time, error: pageOutlet.pageError })}</output>
    <button onClick={() => void pageOutlet.dashboardPage.onExport()}>export</button>
    <button onClick={() => void pageOutlet.healthPage.onRefresh()}>refresh health</button>
    <button onClick={() => void pageOutlet.configPage.actions.saveConfig({ preventDefault: noop } as React.FormEvent)}>save config</button>
    {metadataConfig && <button onClick={() => void pageOutlet.configPage.actions.receiveOAuthConfig(metadataConfig)}>config metadata</button>}
  </>;
}

describe("health request ownership", () => {
  for (const succeeds of [false, true]) {
    it.each(["logs", "config", "health", "operation"] as const)(
      `settles an in-flight health refresh after %s evidence, success=${succeeds}`, async evidence => {
        const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
        const original = store.toPublicConfig();
        await store.patch({ logging: { keep_recent: 250 } });
        const saved = store.toPublicConfig();
        const refresh = deferredResponse();
        let afterWrite = false;
        const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/config") {
            if (init?.method === "PATCH") afterWrite = true;
            return Response.json(afterWrite ? saved : original);
          }
          if (url === "/api/health") return afterWrite ? refresh.promise : Response.json({ time: "initial" });
          if (url.startsWith("/api/config/export")) return Response.json({
            error: afterWrite ? "new export error" : "earlier export error"
          }, { status: 500 });
          if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
          throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetcher);
        const view = await mount(<HealthHarness healthMode={false} metadataConfig={saved} />);
        await click(view.container, "export");
        expect(renderedState(view.container).error).toBe("earlier export error");
        await click(view.container, "save config");
        const stream = TestEventSource.instances.at(-1)!;
        if (evidence === "operation") await click(view.container, "export");
        else if (evidence === "config") await click(view.container, "config metadata");
        else if (evidence === "logs") {
          const callsBefore = fetcher.mock.calls.filter(([url]) => url.startsWith("/api/logs/recent?")).length;
          await act(async () => stream.emit("error"));
          expect(fetcher.mock.calls.filter(([url]) => url.startsWith("/api/logs/recent?")).length).toBeGreaterThan(callsBefore);
        } else await act(async () => stream.emit("snapshot", {
          config: saved, health: { time: "newer SSE" }, log_page: emptyLogPage(200)
        }));
        await act(async () => succeeds ? refresh.json({ time: "refreshed" }) : refresh.reject(new Error("health outage")));
        const result = renderedState(view.container);
        expect(result.healthTime).toBe(evidence === "health" ? "newer SSE" : succeeds ? "refreshed" : undefined);
        const exportError = evidence === "operation" ? "new export error" : "earlier export error";
        if (evidence === "health" || succeeds) expect(result.error).toBe(exportError);
        else expect(result.error).toBe(`配置已写入，但健康状态刷新失败：health outage。请重试状态刷新，无需重复保存。; ${exportError}`);
      }
    );
  }

  it.each([false, true])("clears a recovered SSE health error while preserving a newer operation error=%s", async newerError => {
    const config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
    let afterWrite = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/config") {
        if (init?.method === "PATCH") afterWrite = true;
        return Response.json(config);
      }
      if (url === "/api/health") return afterWrite
        ? Response.json({ error: "health outage" }, { status: 503 }) : Response.json({ time: "initial" });
      if (url.startsWith("/api/config/export")) return Response.json({ error: "new export error" }, { status: 500 });
      if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
      throw new Error(`Unexpected request: ${url}`);
    });
    const view = await mount(<HealthHarness healthMode={false} />);
    await click(view.container, "save config");
    expect(renderedState(view.container).error).toContain("health outage");
    const stream = TestEventSource.instances.at(-1)!;
    // A log poll or open socket proves nothing about the health snapshot.
    await act(async () => { stream.emit("error"); });
    await act(async () => { stream.emit("open"); });
    expect(renderedState(view.container).error).toContain("health outage");
    if (newerError) await click(view.container, "export");
    await act(async () => stream.emit("snapshot", { config, health: { time: "recovered" }, log_page: emptyLogPage(200) }));
    expect(renderedState(view.container)).toEqual({ healthTime: "recovered", error: newerError ? "new export error" : null });
  });

  it("displays a slow poll and schedules the next poll only after it settles", async () => {
    const config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
    const poll = deferredResponse();
    let pending = false;
    const fetchPoll = vi.fn(() => poll.promise);
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/config") return Response.json(config);
      if (url === "/api/health") return pending ? fetchPoll() : Response.json({ time: "initial" });
      throw new Error(`Unexpected request: ${url}`);
    });
    const view = await mount(<HealthHarness healthMode />);
    pending = true;
    await act(async () => vi.advanceTimersByTimeAsync(24000));
    expect(fetchPoll).toHaveBeenCalledTimes(1);
    await act(async () => poll.json({ time: "slow success" }));
    expect(renderedState(view.container).healthTime).toBe("slow success");
    await act(async () => vi.advanceTimersByTimeAsync(3999));
    expect(fetchPoll).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchPoll).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "error"] as const)("ignores an obsolete poll's %s after navigation", async outcome => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = store.toPublicConfig();
    const poll = deferredResponse();
    let polling = false;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/config") return Promise.resolve(Response.json(config));
      if (url === "/api/health") return polling ? poll.promise : Promise.resolve(Response.json({ time: "initial" }));
      if (url.startsWith("/api/config/export")) return Promise.resolve(Response.json({ error: "new export error" }, { status: 500 }));
      if (url.startsWith("/api/logs/recent?")) return Promise.resolve(Response.json(emptyLogPage(200)));
      throw new Error(`Unexpected request: ${url}`);
    }));
    const view = await mount(<HealthHarness healthMode={false} />);
    await view.render(<HealthHarness healthMode />);
    polling = true;
    await act(async () => vi.advanceTimersByTime(4000));
    polling = false;
    await view.render(<HealthHarness healthMode={false} />);
    await act(async () => TestEventSource.instances.at(-1)!.emit("snapshot", {
      config, health: { time: "newer SSE" }, log_page: emptyLogPage(200)
    }));
    await click(view.container, "export");
    await act(async () => outcome === "success" ? poll.json({ time: "old poll" }) : poll.reject(new Error("old failure")));
    expect(renderedState(view.container)).toEqual({ healthTime: "newer SSE", error: "new export error" });
  });

  it.each(["success", "error"] as const)("does not overwrite newer state after a saved config: %s", async outcome => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = store.toPublicConfig();
    const refresh = deferredResponse();
    let refreshing = false;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/config") {
        if (init?.method === "PATCH") refreshing = true;
        return Promise.resolve(Response.json(config));
      }
      if (url === "/api/health") return refreshing ? refresh.promise : Promise.resolve(Response.json({ time: "initial" }));
      if (url.startsWith("/api/config/export")) return Promise.resolve(Response.json({ error: "new export error" }, { status: 500 }));
      if (url.startsWith("/api/logs/recent?")) return Promise.resolve(Response.json(emptyLogPage(200)));
      throw new Error(`Unexpected request: ${url}`);
    }));
    const view = await mount(<HealthHarness healthMode={false} />);
    await click(view.container, "save config");
    await act(async () => TestEventSource.instances.at(-1)!.emit("snapshot", {
      config, health: { time: "newer SSE" }, log_page: emptyLogPage(200)
    }));
    await click(view.container, "export");
    await act(async () => outcome === "success" ? refresh.json({ time: "old write refresh" }) : refresh.reject(new Error("old refresh failure")));
    expect(renderedState(view.container)).toEqual({ healthTime: "newer SSE", error: "new export error" });
  });

  it.each([false, true])("preserves an operation error across health recovery, initial failure=%s", async initiallyFails => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = store.toPublicConfig();
    let healthFails = false;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/config") return Promise.resolve(Response.json(config));
      if (url === "/api/health") return Promise.resolve(healthFails
        ? Response.json({ error: "health failure" }, { status: 503 }) : Response.json({ time: "healthy" }));
      if (url.startsWith("/api/config/export")) return Promise.resolve(Response.json({ error: "export error" }, { status: 500 }));
      if (url.startsWith("/api/logs/recent?")) return Promise.resolve(Response.json(emptyLogPage(200)));
      throw new Error(`Unexpected request: ${url}`);
    }));
    const view = await mount(<HealthHarness healthMode={false} />);
    await view.render(<HealthHarness healthMode />);
    await click(view.container, "export");
    healthFails = initiallyFails;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(renderedState(view.container).error).toBe(initiallyFails ? "health failure; export error" : "export error");
    healthFails = false;
    await click(view.container, "refresh health");
    expect(renderedState(view.container)).toEqual({ healthTime: "healthy", error: "export error" });
  });
});

describe("real React lifecycle races", () => {
  it("pins an overwrite confirmation to the original profile ID and draft revision", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    await store.saveProfile("codex", "Target", { primary: { model_override: "original" } });
    await store.saveProfile("codex", "Other", { primary: { model_override: "other" } });
    const initial = store.toPublicConfig();
    const [original, other] = initial.profiles;
    const writes: Array<{ method?: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/config") return Response.json(initial);
      if (url === "/api/health") return Response.json(null);
      if (url === "/api/oauth/accounts") return Response.json({ accounts: [] });
      if (url === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url === "/api/config/profiles" && init) {
        const body = JSON.parse(String(init.body));
        writes.push({ method: init.method, body });
        try {
          if (init.method === "PATCH") await store.updateProfile("codex", body.profile_id, body.name, body.config, body.revision);
          else await store.saveProfile("codex", body.name, body.config, body.revision);
          return Response.json(store.toPublicConfig());
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 409 });
        }
      }
      return Response.json(emptyLogPage(200));
    });
    function Harness() {
      const { pageOutlet: { configPage } } = useStudioPageModels({
        currentPage: "config", configTab: "profiles", healthMode: false, pageMode: "config", onConfigTabChange: noop
      });
      return <ConfigPage {...configPage} displayScope="codex" onDisplayScopeChange={noop} />;
    }
    // jsdom doesn't implement native dialog presentation.
    const create = document.createElement.bind(document);
    const elements = vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
      const element = create(tag, options);
      if (element instanceof HTMLDialogElement) {
        element.showModal = () => { element.open = true; };
        element.close = () => { element.open = false; };
      }
      return element;
    });
    try {
      const { container } = await mount(<Harness />);
      const card = container.querySelector<HTMLElement>(".profile-card-codex")!;
      await click(card, "+ 新建档案");
      const input = card.querySelector<HTMLInputElement>("#codex-profile-name")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Target");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click(card, "保存当前 Codex 草稿为新档案");
      const dialog = card.querySelector<HTMLDialogElement>("dialog[open]")!;
      expect(dialog).not.toBeNull();
      await store.updateProfile("codex", original.id, "Moved", undefined);
      await store.updateProfile("codex", other.id, "Target", undefined);
      const updated = store.toPublicConfig();
      await act(async () => TestEventSource.instances.at(-1)!.emit("snapshot", {
        config: updated, health: null, log_page: emptyLogPage(200)
      }));
      await click(dialog, "覆盖档案「Target」");
      expect(writes).toMatchObject([{ method: "PATCH", body: { profile_id: original.id, revision: initial.revision } }]);
      expect(store.toPublicConfig()).toEqual(updated);
      expect(dialog.open).toBe(true);
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("重新确认");
    } finally { elements.mockRestore(); }
  });

  it("previews GET without parsing or sending the POST draft, and POST presets restore it", async () => {
    const config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
    const requests: Array<Record<string, unknown>> = [];
    const delayed = deferredResponse();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === "/api/test-route") {
        requests.push(JSON.parse(String(init.body)));
        if (requests.length === 2) {
          signal = init.signal;
          return delayed.promise;
        }
        return Response.json({ route: "claude", method: "GET", upstream_url: "https://upstream.example/v1/models" });
      }
      if (url === "/api/config") return Response.json(config);
      if (url === "/api/health") return Response.json({ time: "initial" });
      return Response.json(emptyLogPage(200));
    });
    function Harness() {
      const { pageOutlet: { routesPage } } = useStudioPageModels({
        currentPage: "routes", configTab: "profiles", healthMode: false, pageMode: "routes", onConfigTabChange: noop
      });
      return <ConfigPreviewPanel {...routesPage.previewPanel} />;
    }
    const { container } = await mount(<Harness />);
    const method = container.querySelector<HTMLSelectElement>("#preview-method")!;
    expect(method?.labels?.[0].textContent).toBe("请求方法");
    const body = container.querySelector<HTMLTextAreaElement>("#preview-body")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(body, "{unfinished"); body.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { method.value = "GET"; method.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(body.disabled).toBe(true);
    await click(container, "Claude 模型");
    await click(container, "试算路由");
    expect(requests).toEqual([{ path: "/anthropic/models", method: "GET", headers: {} }]);
    expect(container.textContent).toContain("https://upstream.example/v1/models");
    await click(container, "普通响应");
    expect(container.querySelector(".config-preview-result")).toBeNull();
    expect(method.value).toBe("POST");
    expect(body.disabled).toBe(false);
    expect(body.value).toBe("{unfinished");
    await click(container, "试算路由");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(requests).toHaveLength(1);
    await act(async () => { setValue.call(body, "{}"); body.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click(container, "试算路由");
    const headers = container.querySelector<HTMLTextAreaElement>("#preview-headers")!;
    await act(async () => { setValue.call(headers, '{"accept":"text/event-stream"}'); headers.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(signal?.aborted).toBe(true);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    await act(async () => delayed.json({ route: "primary", method: "POST", upstream_url: "https://stale.example/late" }));
    expect(container.querySelector(".config-preview-result")).toBeNull();
  });

  it.each(["codex", "claude"] as const)("keeps a newer %s profile draft when SSE precedes the save response", async (scope) => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const initial = store.toPublicConfig();
    await store.saveProfile(scope, "Submitted", {});
    const saved = store.toPublicConfig();
    const savedId = saved.profile_scopes[scope].profiles[0].id;
    const save = deferredResponse();
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/config/profiles" && init?.method === "POST") return save.promise;
      if (url === "/api/config") return Promise.resolve(Response.json(initial));
      if (url === "/api/health") return Promise.resolve(Response.json(null));
      if (url.startsWith("/api/logs/recent?")) return Promise.resolve(Response.json(emptyLogPage(200)));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<ProfileHarness scope={scope} />);
    await click(view.container, "draft");
    await click(view.container, "save");
    expect(JSON.parse(fetcher.mock.calls.find(([url]) => url === "/api/config/profiles")![1]!.body as string)).toMatchObject({ scope, name: "Submitted" });
    await click(view.container, "edit again");
    const stream = TestEventSource.instances.at(-1)!;
    await act(async () => stream.emit("snapshot", { config: saved, health: null, log_page: emptyLogPage(200) }));
    expect(view.container.querySelector("[data-name]")!.textContent).toBe("Newer edit");
    expect(view.container.querySelector("[data-selected]")!.textContent).toBe("");
    await act(async () => save.json(saved));
    expect(view.container.querySelector("[data-name]")!.textContent).toBe("Newer edit");
    expect(view.container.querySelector("[data-selected]")!.textContent).toBe(savedId);
    expect(view.container.querySelector("[data-draft]")!.textContent).toBe("777");
    await act(async () => stream.emit("snapshot", { config: saved, health: null, log_page: emptyLogPage(200) }));
    expect(view.container.querySelector("[data-name]")!.textContent).toBe("Newer edit");
    await view.unmount();
    expect(TestEventSource.instances.every((item) => item.closed)).toBe(true);
    const completedRequests = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(5000));
    expect(fetcher).toHaveBeenCalledTimes(completedRequests);
  });

  it.each(["success", "error"] as const)("does not revive the first A request's %s after A -> B -> A", async (outcome) => {
    const first = deferredResponse();
    const current = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(current.promise));
    const view = await mount(<ModelsHarness source="A" />);
    await click(view.container, "load");
    await view.render(<ModelsHarness source="B" />);
    expect(renderedState(view.container)).toMatchObject({ state: "idle", models: [] });
    await view.render(<ModelsHarness source="A" />);
    expect(renderedState(view.container)).toMatchObject({ state: "idle", models: [] });
    await act(async () => {
      if (outcome === "success") first.json({ models: ["stale-A"], upstream_host: "a.example", error: null });
      else first.reject(new Error("stale-A error"));
    });
    expect(renderedState(view.container)).toMatchObject({ state: "idle", models: [] });
    await click(view.container, "load");
    await act(async () => current.json({ models: ["fresh-A"], upstream_host: "a.example", error: null }));
    expect(renderedState(view.container)).toMatchObject({ state: "loaded", models: ["fresh-A"] });
    expect(view.container.textContent).not.toContain("stale");
  });

  it("debounces ten separate search keystrokes, but applies route changes and clearing immediately", async () => {
    const fetcher = vi.fn(async (_url: string) => Response.json(logPage(["initial"], 1)));
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<LogsHarness />);
    fetcher.mockClear();
    for (let index = 0; index < 10; index += 1) {
      await click(view.container, "type next");
      await act(async () => vi.advanceTimersByTime(60));
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(renderedState(view.container).stale).toBe(true);
    await act(async () => vi.advanceTimersByTime(190));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("search=xxxxxxxxxx");
    await click(view.container, "type next");
    await click(view.container, "compact");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain("route=compact");
    expect(String(fetcher.mock.calls[1][0])).toContain("search=xxxxxxxxxxx");
    await click(view.container, "clear search");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2][0])).not.toContain("search=");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("aborts a replaced search immediately and cancels the debounce on unmount", async () => {
    const pending: Array<{ signal: AbortSignal; response: ReturnType<typeof deferredResponse> }> = [];
    let initial = true;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      if (initial) return Promise.resolve(Response.json(logPage(["initial"], 1)));
      const response = deferredResponse();
      pending.push({ signal: init.signal as AbortSignal, response });
      return response.promise;
    }));
    const view = await mount(<LogsHarness />);
    initial = false;
    await click(view.container, "type next");
    await act(async () => vi.advanceTimersByTime(250));
    expect(pending).toHaveLength(1);
    await click(view.container, "type next");
    expect(pending[0].signal?.aborted).toBe(true);
    await act(async () => pending[0].response.json(logPage(["stale"], 1)));
    expect(renderedState(view.container)).toMatchObject({ ids: ["initial"], loading: true, error: null });
    await view.unmount();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(pending).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "error"] as const)("refreshes filtered logs after reconnect while the old poll settles with %s", async outcome => {
    const poll = deferredResponse();
    const recovery = deferredResponse();
    let pollSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(logPage(["old"], 1, "compact")));
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<LogsHarness />);
    await click(view.container, "compact");
    fetcher.mockImplementationOnce((_url, init) => { pollSignal = init?.signal; return poll.promise; });
    const stream = TestEventSource.instances.at(-1)!;
    await act(async () => stream.emit("error"));
    fetcher.mockImplementationOnce(() => recovery.promise);
    await act(async () => stream.emit("open"));
    expect(pollSignal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "success") poll.json(logPage(["obsolete-poll"], 1, "compact"));
      else poll.reject(new Error("obsolete poll failure"));
    });
    expect(renderedState(view.container)).toMatchObject({ ids: ["old"], loading: true, error: null });
    fetcher.mockImplementation(async () => Response.json(logPage(["missed-during-outage"], 1, "compact")));
    await act(async () => {
      stream.emit("snapshot", { config: { revision: "synthetic" }, health: {}, log_page: emptyLogPage(2) });
      recovery.json(logPage(["before-snapshot"], 1, "compact"));
    });
    expect(renderedState(view.container)).toMatchObject({ ids: ["missed-during-outage"], loading: false, stale: false, error: null });
  });

  it.each([
    ["more", "success"], ["more", "error"], ["reconnect", "success"], ["reconnect", "error"]
  ] as const)("ignores old %s %s without clearing a newer filter's loading flag", async (operation, outcome) => {
    const pending: Array<{ url: URL; signal: AbortSignal; response: ReturnType<typeof deferredResponse> }> = [];
    let initialLoad = true;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (initialLoad) return Promise.resolve(Response.json(logPage(["4", "3"], 4)));
      const response = deferredResponse();
      pending.push({ url: new URL(url, "http://test.invalid"), signal: init.signal as AbortSignal, response });
      return response.promise;
    }));
    const take = () => { const request = pending.shift(); expect(request).toBeDefined(); return request!; };
    const view = await mount(<LogsHarness />);
    expect(renderedState(view.container)).toMatchObject({ ids: ["4", "3"], loading: false });
    initialLoad = false;
    const stream = TestEventSource.instances.at(-1)!;
    if (operation === "more") {
      await click(view.container, "more");
    } else {
      await act(async () => stream.emit("error"));
      const poll = take();
      await act(async () => poll.response.json(logPage(["4", "3"], 4)));
      await act(async () => stream.emit("open"));
    }
    const stale = take();
    expect(stale.url.searchParams.get("offset")).toBe(operation === "more" ? "2" : "0");
    await click(view.container, "compact");
    const compact = take();
    expect(stale.signal?.aborted).toBe(true);
    expect(compact.url.searchParams.get("route")).toBe("compact");
    await act(async () => {
      if (outcome === "success") stale.response.json(logPage(["old-result"], 1));
      else stale.response.reject(new Error("stale request"));
    });
    expect(renderedState(view.container)).toMatchObject({ ids: ["4", "3"], loading: true, more: false, stale: true, error: null });
    await act(async () => compact.response.json(logPage(["compact"], 1, "compact")));
    expect(renderedState(view.container)).toEqual({ ids: ["compact"], total: 1, loading: false, more: false, stale: false, error: null });
    await click(view.container, "primary");
    const afterUnmount = take();
    await view.unmount();
    expect(afterUnmount.signal?.aborted).toBe(true);
    expect(TestEventSource.instances.every((item) => item.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { afterUnmount.response.json(logPage(["too-late"], 1)); stream.emit("error"); });
    expect(pending).toHaveLength(0);
    expect(view.container.textContent).toBe("");
  });
});

function logPage(ids: string[], total: number, route: "primary" | "compact" = "primary"): RequestLogPage {
  const logs: RequestLogEntry[] = ids.map((request_id) => ({
    request_id, route, time: "2026-10-23T00:00:00.000Z", completed_at: "2026-10-23T00:00:01.000Z",
    method: "POST", path: "/v1/responses", endpoint: "/responses", request_type: "stream", reasoning_effort: null,
    request_summary: null, incoming_request_body: null, upstream_request_body: null, upstream_response_body: null,
    client_response_body: null, body_status: "none", compact_response_normalized: false,
    compact_response_normalize_reason: null, compact_response_synthetic_source: null,
    source_model: "synthetic", target_model: "synthetic", response_model: "synthetic", status: 200,
    duration_ms: 1, first_token_ms: null, input_tokens: null, output_tokens: null, cached_input_tokens: null,
    cached_output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, reasoning_tokens: null,
    additive_cached_input_tokens: false, additive_cached_output_tokens: false, total_tokens: null,
    upstream_host: "synthetic.invalid", user_agent: null, key_name: null, error_summary: null,
    capture_path: null, capture_status: "none"
  }));
  return { ...emptyLogPage(2), logs, total, all_total: total, has_more: ids.length < total,
    counts: { all: total, primary: route === "primary" ? total : 0, compact: route === "compact" ? total : 0, claude: 0 } };
}
