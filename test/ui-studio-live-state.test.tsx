// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { ClientIdentityStore } from "../src/server/client-identity-store.js";
import { useStudioPageModels } from "../src/ui/app/useStudioPageModels.js";
import { ClientIdentityPanel } from "../src/ui/routes/ClientIdentityPanel.js";
import { LogCaptureViewer } from "../src/ui/logs/LogCaptureViewer.js";
import { emptyLogPage } from "../src/ui/logs/log-utils.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const roots = new Set<Root>();
const noop = () => undefined;
class SyntheticEventSource extends EventTarget {
  static current: SyntheticEventSource;
  constructor() { super(); SyntheticEventSource.current = this; }
  close() {}
  snapshot(value: unknown) { this.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(value) })); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", SyntheticEventSource);
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { matches: true, media }));
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
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const render = (next: ReactNode) => act(async () => root.render(<StrictMode>{next}</StrictMode>));
  await render(node);
  return { host, render };
}

function IdentityHarness({ page }: { page: "health" | "routes" | "dashboard" }) {
  const models = useStudioPageModels({ currentPage: page, configTab: "profiles",
    healthMode: page === "health", pageMode: page, onConfigTabChange: noop });
  return page === "routes" ? <ClientIdentityPanel status={models.sidebarHealth?.client_identity ?? null}
    onStatusChange={models.pageOutlet.routesPage.onClientIdentityChange} /> : null;
}

it.each([false, true])("retains a confirmed identity toggle across Studio navigation, SSE=%s", async withSnapshot => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const config = store.toPublicConfig();
  store.oauth.close();
  const enabled = { ...new ClientIdentityStore({ statePath: "unused-synthetic-state" }).status(), enabled: true };
  const disabled = { ...enabled, enabled: false };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return Response.json(config);
    if (url === "/api/health") return Response.json({ time: "initial", client_identity: enabled });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url === "/api/client-identity" && init?.method === "POST") return Response.json(disabled);
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  if (!withSnapshot) vi.stubGlobal("EventSource", undefined);
  const view = await mount(<IdentityHarness page="routes" />);
  const toggle = () => view.host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  if (withSnapshot) await act(async () => SyntheticEventSource.current.snapshot({
    config, health: { time: "written", client_identity: disabled }, log_page: emptyLogPage(200)
  }));
  const healthReads = fetcher.mock.calls.filter(([url]) => url === "/api/health").length;
  await view.render(<IdentityHarness page="dashboard" />);
  await view.render(<IdentityHarness page="routes" />);
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/health")).toHaveLength(healthReads);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
});

it.each(["older-read", "fresh-read", "snapshot-before-older-read"] as const)(
  "keeps a confirmed identity toggle when health finishes later: %s", async sequence => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    const config = store.toPublicConfig();
  store.oauth.close();
    const enabled = { ...new ClientIdentityStore({ statePath: "unused-synthetic-state" }).status(), enabled: true };
    const disabled = { ...enabled, enabled: false };
    let routesEntered = false;
    let finishHealth!: (response: Response) => void;
    const olderHealth = new Promise<Response>(resolve => { finishHealth = resolve; });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/config") return Response.json(config);
      if (url === "/api/health") return routesEntered ? olderHealth : Response.json({ time: "before-write", client_identity: enabled });
      if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
      if (url === "/api/client-identity" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
        return Response.json(disabled);
      }
      throw new Error(`Unexpected synthetic request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const view = await mount(<IdentityHarness page="health" />);
    routesEntered = true;
    await view.render(<IdentityHarness page="routes" />);
    const toggle = () => view.host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(false);
    if (sequence === "snapshot-before-older-read") await act(async () => SyntheticEventSource.current.snapshot({
      config, health: { time: "after-write", client_identity: disabled }, log_page: emptyLogPage(200)
    }));
    await act(async () => finishHealth(Response.json({ time: sequence === "fresh-read" ? "after-write" : "before-write",
      client_identity: sequence === "fresh-read" ? disabled : enabled })));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/client-identity")).toHaveLength(1);
  }
);

it.each([
  [false, "present", "查看抓包"], [true, "present", "查看抓包"],
  [false, "purged", "原始文件已清理"], [true, "purged", "原始文件已清理"],
  [false, "none", "本次请求没有抓包"], [true, "none", "本次请求没有抓包"]
] as const)("accepts a later capture lifecycle update after read202=%s to %s", async (read202, next, expected) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ capture_status: "pending", error: "Capture is pending" }, { status: 202 })));
  const entry = { request_id: "synthetic-capture", capture_status: "pending" as const, body_status: "none" as const };
  const view = await mount(<LogCaptureViewer entry={entry} />);
  if (read202) await act(async () => view.host.querySelector<HTMLButtonElement>("button")!.click());
  expect(view.host.textContent).toContain("抓包仍在写入");
  await view.render(<LogCaptureViewer entry={{ ...entry, capture_status: next }} />);
  expect(view.host.textContent).toContain(expected);
  expect(view.host.textContent).not.toContain("抓包仍在写入");
});

it("ignores a late pending response after the log reports a present capture", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const entry = { request_id: "synthetic-late-capture", capture_status: "pending" as const, body_status: "none" as const };
  const view = await mount(<LogCaptureViewer entry={entry} />);
  await act(async () => view.host.querySelector<HTMLButtonElement>("button")!.click());
  await view.render(<LogCaptureViewer entry={{ ...entry, capture_status: "present" }} />);
  await act(async () => finish(Response.json({ error: "Capture is pending" }, { status: 202 })));
  expect(view.host.textContent).toContain("查看抓包");
  expect(view.host.textContent).not.toContain("抓包仍在写入");
});

it.each([false, true])("preserves newer identity snapshots while a write is pending, writeFailed=%s", async failed => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const config = store.toPublicConfig();
  store.oauth.close();
  const enabled = { ...new ClientIdentityStore({ statePath: "unused-synthetic-state" }).status(), enabled: true };
  let finishWrite!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return Response.json(config);
    if (url === "/api/health") return Response.json({ client_identity: enabled });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url === "/api/client-identity") return init?.method === "POST"
      ? new Promise<Response>(resolve => { finishWrite = resolve; }) : Response.json(enabled);
    throw new Error("Unexpected synthetic request");
  }));
  const view = await mount(<IdentityHarness page="routes" />);
  await act(async () => view.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  await act(async () => SyntheticEventSource.current.snapshot({ config,
    health: { time: "newer", client_identity: enabled }, log_page: emptyLogPage(200) }));
  await act(async () => finishWrite(failed ? Response.json({ error: "Synthetic failed write" }, { status: 500 })
    : Response.json({ ...enabled, enabled: false })));
  expect(view.host.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
  if (failed) expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Synthetic failed write");
  await view.render(<IdentityHarness page="dashboard" />);
  await view.render(<IdentityHarness page="routes" />);
  expect(view.host.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
});

it("keeps the toggle pending during reconciliation and preserves a snapshot received after the read started", async () => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const config = store.toPublicConfig();
  store.oauth.close();
  const enabled = new ClientIdentityStore({ statePath: "unused-synthetic-state" }).status();
  let finishWrite!: (response: Response) => void;
  let finishRead!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return Response.json(config);
    if (url === "/api/health") return Response.json({ client_identity: enabled });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url === "/api/client-identity") return new Promise<Response>(resolve => {
      if (init?.method === "POST") finishWrite = resolve;
      else finishRead = resolve;
    });
    throw new Error("Unexpected synthetic request");
  }));
  const view = await mount(<IdentityHarness page="routes" />);
  const toggle = () => view.host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => toggle().click());
  const snapshot = () => SyntheticEventSource.current.snapshot({ config, health: { client_identity: enabled }, log_page: emptyLogPage(200) });
  await act(async () => snapshot());
  await act(async () => finishWrite(Response.json({ ...enabled, enabled: false })));
  expect(toggle().disabled).toBe(true);
  await act(async () => snapshot());
  await act(async () => finishRead(Response.json({ ...enabled, enabled: false })));
  expect(toggle().disabled).toBe(false);
  expect(toggle().getAttribute("aria-checked")).toBe("true");
});
