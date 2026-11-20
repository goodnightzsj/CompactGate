// @vitest-environment jsdom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { useStudioBootstrap } from "../src/ui/hooks/useStudioBootstrap.js";
import { useHealthRefresh } from "../src/ui/hooks/useHealthRefresh.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

it.each([
  [false, false, false], [false, true, false], [true, true, false],
  [false, true, true], [true, true, true]
])("handles post-import health success=%s, prior error=%s, newer error=%s", async (succeeds, priorError, newerError) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const initial = store.toPublicConfig();
  const imported = { ...initial, revision: "imported" };
  let importing = false;
  let finishHealth!: (value: Response) => void;
  const healthResult = new Promise<Response>(resolve => { finishHealth = resolve; });
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/config/import") { importing = true; return Response.json(imported); }
    if (url === "/api/config") return Response.json(initial);
    if (url === "/api/health") return importing ? healthResult : Response.json({ time: "initial" });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  let state!: ReturnType<typeof useStudioBootstrap>;
  let actions!: ReturnType<typeof useConfigActions>;
  function Harness() {
    state = useStudioBootstrap("config");
    const health = useHealthRefresh({ enabled: false, health: state.health, healthRevision: state.healthRevision,
      pageErrorRevision: state.pageErrorRevision, setHealth: state.setHealth,
      applyHealthRefreshResult: state.applyHealthRefreshResult });
    actions = useConfigActions({ ...state, linkedCompactModel: "synthetic", refreshHealthAfterWrite: health.refreshHealthAfterWrite });
    return <output>{state.pageError}</output>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    if (priorError) await act(async () => state.setPageError("Earlier export failure"));
    let request!: Promise<void>;
    await act(async () => { request = actions.importConfig({}); });
    expect(state.config?.revision).toBe("imported");
    if (newerError) await act(async () => state.setPageError("New export failure"));
    await act(async () => {
      finishHealth(Response.json(succeeds ? { time: "refreshed" } : { error: "Synthetic health failure" }, { status: succeeds ? 200 : 503 }));
      await request;
    });
    if (newerError) expect(state.pageError).toBe("New export failure");
    else if (succeeds) expect(state.pageError).toBeNull();
    else expect(state.pageError).toContain("配置已写入，但健康状态刷新失败：Synthetic health failure");
    expect(state.health?.time ?? null).toBe(succeeds ? "refreshed" : null);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/config/import")).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
