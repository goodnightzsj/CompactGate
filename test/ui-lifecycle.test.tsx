// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import type { ConfigProfileScope, RequestLogEntry, RequestLogPage } from "../src/shared/types.js";
import { useStudioPageModels } from "../src/ui/app/useStudioPageModels.js";
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
    applyRemoteConfig: noop, onServerRecovered: noop, setHealth: noop });
  return <>
    <output>{JSON.stringify({ ids: feed.logPage.logs.map((entry) => entry.request_id), total: feed.logPage.total,
      loading: feed.isLoadingLogs, more: feed.isLoadingMoreLogs, stale: feed.hasStaleLogs, error: feed.logError })}</output>
    <button onClick={() => void feed.loadMoreLogs()}>more</button>
    <button onClick={() => feed.setRouteFilter("compact")}>compact</button>
    <button onClick={() => feed.setRouteFilter("primary")}>primary</button>
  </>;
}

function renderedState(container: HTMLElement) {
  return JSON.parse(container.querySelector("output")!.textContent!);
}

describe("real React lifecycle races", () => {
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

  it.each([
    ["more", "success"], ["more", "error"], ["reconnect", "success"], ["reconnect", "error"]
  ] as const)("ignores old %s %s without clearing a newer filter's loading flag", async (operation, outcome) => {
    const pending: Array<{ url: URL; response: ReturnType<typeof deferredResponse> }> = [];
    let initialLoad = true;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (initialLoad) return Promise.resolve(Response.json(logPage(["4", "3"], 4)));
      const response = deferredResponse();
      pending.push({ url: new URL(url, "http://test.invalid"), response });
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
