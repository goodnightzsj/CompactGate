// @vitest-environment jsdom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { useStudioPageModels } from "../src/ui/app/useStudioPageModels.js";
import { emptyLogPage } from "../src/ui/logs/log-utils.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

class SyntheticEventSource extends EventTarget {
  static current: SyntheticEventSource;
  constructor() { super(); SyntheticEventSource.current = this; }
  close() {}
}

it("keeps a bootstrap health failure after an unrelated config-only write", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", undefined);
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { media, matches: true }));
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const original = store.toPublicConfig();
  let healthFails = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/config") return Response.json(original);
    if (url === "/api/health") return healthFails
      ? Response.json({ error: "health temporarily unavailable" }, { status: 503 })
      : Response.json({ time: "old health" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  let models!: ReturnType<typeof useStudioPageModels>;
  function Harness() {
    models = useStudioPageModels({ currentPage: "config", configTab: "profiles", healthMode: false,
      pageMode: "config", onConfigTabChange: () => undefined });
    return <output>{models.pageOutlet.pageError}</output>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    healthFails = true;
    await act(async () => models.pageOutlet.onRetry());
    expect(models.pageOutlet.pageError).toBe("health temporarily unavailable");
    expect(models.pageOutlet.hasStaleData).toBe(true);
    const healthReads = fetcher.mock.calls.filter(([url]) => url === "/api/health").length;
    const metadata = { ...original, revision: `${original.revision}-metadata` };
    // The real OAuth/profile metadata response path contains config, never health.
    await act(async () => models.pageOutlet.configPage.actions.receiveOAuthConfig(metadata));
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/health")).toHaveLength(healthReads);
    expect(models.sidebarHealth?.time).toBe("old health");
    expect(models.pageOutlet.pageError).toBe("health temporarily unavailable");
    expect(models.pageOutlet.hasStaleData).toBe(true);
  } finally {
    await act(async () => root.unmount()); host.remove();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
});

it.each([
  ["bootstrap", false, false], ["after-write", false, false],
  ["bootstrap", true, false], ["after-write", true, false],
  ["bootstrap", true, true], ["after-write", true, true]
] as const)("owns %s health across partial updates, newer snapshot=%s and late failure=%s", async (mode, newerSnapshot, fails) => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", SyntheticEventSource);
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { media, matches: true }));
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const config = store.toPublicConfig();
  let refreshing = false;
  let resolveHealth!: (response: Response) => void;
  const pendingHealth = new Promise<Response>(resolve => { resolveHealth = resolve; });
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/config") return Response.json(config);
    if (url === "/api/health") return refreshing ? pendingHealth
      : Response.json({ time: "old health", codex: { observed_protocol: "remote_v1" } });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    throw new Error(`Unexpected request: ${url}`);
  });
  let models!: ReturnType<typeof useStudioPageModels>;
  function Harness() {
    models = useStudioPageModels({ currentPage: "config", configTab: "profiles", healthMode: false,
      pageMode: "config", onConfigTabChange: () => undefined });
    return <output>{models.sidebarHealth?.time}</output>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    refreshing = true;
    await act(async () => {
      if (mode === "bootstrap") models.pageOutlet.onRetry();
      else void models.pageOutlet.configPage.actions.saveConfig({ preventDefault() {} } as React.FormEvent);
    });
    await act(async () => SyntheticEventSource.current.dispatchEvent(new MessageEvent("log", { data: JSON.stringify({
      operation: "insert", codex_status: { observed_protocol: "remote_v2" },
      entry: { request_id: "compact", sequence: 1, route: "compact", status: 200,
        time: "2026-11-20T00:00:00.000Z", upstream_host: "synthetic.invalid" }
    }) })));
    expect(models.sidebarHealth?.codex.observed_protocol).toBe("remote_v2");
    if (newerSnapshot) await act(async () => SyntheticEventSource.current.dispatchEvent(new MessageEvent("snapshot", {
      data: JSON.stringify({ config, health: { time: "newest health", codex: { observed_protocol: "remote_v2" } },
        logs: [], log_page: emptyLogPage(200) })
    })));
    await act(async () => resolveHealth(Response.json(fails ? { error: "stale health failure" }
      : { time: "fresh health", codex: { observed_protocol: "remote_v1" } }, { status: fails ? 503 : 200 })));
    expect(models.pageOutlet.pageError).toBeNull();
    expect(models.sidebarHealth?.time).toBe(newerSnapshot ? "newest health" : "fresh health");
    expect(models.sidebarHealth?.codex.observed_protocol).toBe("remote_v2");
  } finally {
    await act(async () => root.unmount()); host.remove();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
