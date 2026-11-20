// @vitest-environment jsdom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { useStudioPageModels } from "../src/ui/app/useStudioPageModels.js";
import { emptyLogPage } from "../src/ui/logs/log-utils.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

class BrokenEventSource extends EventTarget {
  static current: BrokenEventSource;
  constructor() { super(); BrokenEventSource.current = this; }
  close() {}
}

it.each(["no-sse", "sse-error"])("reloads missing configuration after a successful log-only poll: %s", async mode => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", mode === "no-sse" ? undefined : BrokenEventSource);
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { matches: true, media }));
  const config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
  let serverRecovered = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/config") return serverRecovered ? Response.json(config) : Response.json({ error: "config temporarily unavailable" }, { status: 503 });
    if (url === "/api/health") return Response.json({ time: "synthetic" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    throw new Error(`Unexpected: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  let models!: ReturnType<typeof useStudioPageModels>;
  function Harness() {
    models = useStudioPageModels({ currentPage: "config", configTab: "routes", healthMode: false, pageMode: "config", onConfigTabChange: () => undefined });
    return <output>{models.pageOutlet.pageError}</output>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    expect(models.pageOutlet.configPage.config).toBeNull();
    expect(models.pageOutlet.pageError).toContain("config temporarily unavailable");
    if (mode === "sse-error") await act(async () => BrokenEventSource.current.dispatchEvent(new Event("error")));
    await act(async () => vi.advanceTimersByTime(2500));
    expect(models.pageOutlet.configPage.config).toBeNull();
    expect(models.pageOutlet.pageError).toContain("config temporarily unavailable");
    serverRecovered = true;
    await act(async () => vi.advanceTimersByTime(2500));
    expect(models.pageOutlet.configPage.config).toEqual(config);
    expect(models.pageOutlet.pageError).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/config").length).toBeGreaterThan(1);
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
