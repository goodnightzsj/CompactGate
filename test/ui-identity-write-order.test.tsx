// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { ClientIdentityStore } from "../src/server/client-identity-store.js";
import { useStudioPageModels } from "../src/ui/app/useStudioPageModels.js";
import { ClientIdentityPanel } from "../src/ui/routes/ClientIdentityPanel.js";
import { emptyLogPage } from "../src/ui/logs/log-utils.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

let root: Root | undefined;
const noop = () => undefined;

function Harness({ page }: { page: "health" | "routes" }) {
  const models = useStudioPageModels({ currentPage: page, configTab: "profiles",
    healthMode: page === "health", pageMode: page, onConfigTabChange: noop });
  return page === "routes" ? <ClientIdentityPanel status={models.sidebarHealth?.client_identity ?? null}
    onStatusChange={models.pageOutlet.routesPage.onClientIdentityChange} /> : null;
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["before", "after", "before-click", "failed", "refresh-failed"] as const)(
  "confirmed identity write survives an older health read settling %s", async order => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { matches: true, media }));
    const dir = await makeConfigDir();
    const configStore = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const config = configStore.toPublicConfig();
    configStore.oauth.close();
    const identity = new ClientIdentityStore({ statePath: path.join(dir, "identity.json") });
    const initial = await identity.update({ enabled: true });
    const staleHealth = Response.json({ time: "before-write", client_identity: initial });
    const read = deferred();
    const write = deferred();
    let routesEntered = false;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/config") return Response.json(config);
      if (url === "/api/health") return routesEntered ? read.promise : Response.json({ client_identity: initial });
      if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
      if (url === "/api/client-identity" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
        return write.promise;
      }
      if (url === "/api/client-identity") return order === "refresh-failed"
        ? Response.json({ error: "Synthetic refresh failed" }, { status: 503 }) : Response.json(identity.status());
      throw new Error(`Unexpected synthetic request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<StrictMode><Harness page="health" /></StrictMode>));
    routesEntered = true;
    await act(async () => root!.render(<StrictMode><Harness page="routes" /></StrictMode>));
    const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    if (order === "before-click") await act(async () => read.resolve(staleHealth));
    await act(async () => toggle().click());
    expect(toggle().disabled).toBe(true);
    if (order === "before" || order === "failed" || order === "refresh-failed") {
      await act(async () => read.resolve(staleHealth));
      expect(identity.status().enabled).toBe(true);
    }
    const status = order === "failed" ? identity.status() : await identity.update({ enabled: false });
    await act(async () => write.resolve(order === "failed"
      ? Response.json({ error: "Synthetic failed write" }, { status: 500 })
      : Response.json(status)));
    if (order === "after") await act(async () => read.resolve(staleHealth));
    expect(fetcher.mock.calls.filter(([url, init]) => url === "/api/client-identity" && init?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url, init]) => url === "/api/client-identity" && init?.method !== "POST"))
      .toHaveLength(order === "before" || order === "refresh-failed" ? 1 : 0);
    expect(identity.status().enabled).toBe(order === "failed");
    expect(toggle().disabled).toBe(false);
    if (order === "failed") expect(host.querySelector('[role="alert"]')?.textContent).toContain("Synthetic failed write");
    if (order === "refresh-failed") expect(host.querySelector('[role="alert"]')?.textContent)
      .toContain("UA 设置已写入，但最新状态刷新失败：Synthetic refresh failed");
    else expect(toggle().getAttribute("aria-checked")).toBe(String(identity.status().enabled));
  }
);
