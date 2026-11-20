// @vitest-environment jsdom
import path from "node:path";
import { act, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { useStudioPageModels } from "../src/ui/app/useStudioPageModels.js";
import { emptyLogPage } from "../src/ui/logs/log-utils.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const roots: Root[] = [];
class SyntheticEventSource extends EventTarget {
  static current: SyntheticEventSource;
  constructor() { super(); SyntheticEventSource.current = this; }
  close() {}
}
const event = { preventDefault() {} } as FormEvent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", SyntheticEventSource);
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { media, matches: true }));
  vi.stubGlobal("URL", URL);
  URL.createObjectURL = vi.fn(() => "blob:synthetic-download");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountModels() {
  let models!: ReturnType<typeof useStudioPageModels>;
  function Harness() {
    models = useStudioPageModels({ currentPage: "routes", configTab: "profiles", healthMode: false,
      pageMode: "routes", onConfigTabChange() {} });
    return <output>{models.pageOutlet.pageError}</output>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<Harness />));
  return () => models;
}

it.each(["bootstrap", "health"].flatMap(source => [false, true].map(failedFirst => ({ source, failedFirst }))))(
  "successful export cannot recover unresolved $source failure, earlier download failed=$failedFirst", async ({ source, failedFirst }) => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const config = store.toPublicConfig();
  let healthFails = source === "bootstrap";
  let exportFails = failedFirst;
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/config") return Response.json(config);
    if (url === "/api/health") return healthFails
      ? Response.json({ error: "Synthetic health unavailable" }, { status: 503 })
      : Response.json({ time: "last healthy" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url.startsWith("/api/config/export")) return exportFails
      ? Response.json({ error: "Synthetic export failure" }, { status: 500 }) : Response.json(store.get());
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const models = await mountModels();
  if (source === "health") {
    healthFails = true;
    await act(async () => models().pageOutlet.healthPage.onRefresh());
  }
  expect(models().pageOutlet.pageError).toBe("Synthetic health unavailable");
  expect(models().pageOutlet.hasStaleData).toBe(source === "bootstrap");
  const healthReads = fetcher.mock.calls.filter(([url]) => url === "/api/health").length;
  if (failedFirst) {
    await act(async () => models().pageOutlet.configPage.actions.exportSavedConfig());
    expect(models().pageOutlet.pageError).toContain("Synthetic health unavailable");
    expect(models().pageOutlet.pageError).toContain("Synthetic export failure");
    expect(models().pageOutlet.hasStaleData).toBe(source === "bootstrap");
    exportFails = false;
  }
  await act(async () => models().pageOutlet.configPage.actions.exportSavedConfig());
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/health")).toHaveLength(healthReads);
  expect(models().pageOutlet.pageError).toBe("Synthetic health unavailable");
  expect(models().pageOutlet.hasStaleData).toBe(source === "bootstrap");
});

it.each([200, 500])("keeps the latest export result when an earlier download finishes, latest=%s", async latestStatus => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const downloads: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/config") return Response.json(store.toPublicConfig());
    if (url === "/api/health") return Response.json({ time: "healthy" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url.startsWith("/api/config/export")) return new Promise<Response>(resolve => downloads.push(resolve));
    throw new Error(`Unexpected request: ${url}`);
  });
  const models = await mountModels();
  await act(async () => { void models().pageOutlet.configPage.actions.exportSavedConfig(); });
  await act(async () => { void models().pageOutlet.configPage.actions.exportSavedConfig(); });
  await act(async () => downloads[1](latestStatus === 200 ? Response.json(store.get())
    : Response.json({ error: "New export failure" }, { status: 500 })));
  await act(async () => downloads[0](latestStatus === 200
    ? Response.json({ error: "Old export failure" }, { status: 500 }) : Response.json(store.get())));
  expect(models().pageOutlet.pageError).toBe(latestStatus === 200 ? null : "New export failure");
});

it.each([false, true])("does not clear health failure received during export, earlier export failed=%s", async earlierFailure => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  let healthFails = false;
  let rejectExport = earlierFailure;
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/config") return Response.json(store.toPublicConfig());
    if (url === "/api/health") return healthFails
      ? Response.json({ error: "New health failure" }, { status: 503 }) : Response.json({ time: "healthy" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url.startsWith("/api/config/export")) return rejectExport
      ? Response.json({ error: "Earlier export failure" }, { status: 500 })
      : new Promise<Response>(resolve => { finish = resolve; });
    throw new Error(`Unexpected request: ${url}`);
  });
  const models = await mountModels();
  if (earlierFailure) {
    await act(async () => models().pageOutlet.configPage.actions.exportSavedConfig());
    rejectExport = false;
  }
  await act(async () => { void models().pageOutlet.configPage.actions.exportSavedConfig(); });
  healthFails = true;
  await act(async () => models().pageOutlet.healthPage.onRefresh());
  await act(async () => finish(Response.json(store.get())));
  expect(models().pageOutlet.pageError).toBe("New health failure");
  expect(models().pageOutlet.hasStaleData).toBe(false);
});

it("successful retry clears its own export failure", async () => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  let exportFails = true;
  const exports: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/config") return Response.json(store.toPublicConfig());
    if (url === "/api/health") return Response.json({ time: "healthy" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url.startsWith("/api/config/export")) {
      exports.push(url);
      return exportFails ? Response.json({ error: "Synthetic export failure" }, { status: 500 }) : Response.json(store.get());
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const models = await mountModels();
  await act(async () => models().pageOutlet.configPage.actions.exportSavedConfig());
  expect(models().pageOutlet.pageError).toBe("Synthetic export failure");
  exportFails = false;
  await act(async () => models().pageOutlet.onRetry());
  expect(models().pageOutlet.pageError).toBeNull();
  expect(exports).toEqual(["/api/config/export", "/api/config/export"]);
});

it.each([false, true])("invalidates a route preview after the saved connection changes (in flight=%s)", async inFlight => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  await store.patch({ primary: { base_url: "https://old.synthetic.invalid/v1" } });
  const config = store.toPublicConfig();
  let resolvePreview!: (response: Response) => void;
  const pendingPreview = new Promise<Response>(resolve => { resolvePreview = resolve; });
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/config") return Response.json(config);
    if (url === "/api/health") return Response.json({ time: "healthy" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url === "/api/test-route") return pendingPreview;
    throw new Error(`Unexpected request: ${url}`);
  });
  const models = await mountModels();
  await act(async () => models().pageOutlet.configPage.actions.setPreviewPath("/v1/responses"));
  await act(async () => { void models().pageOutlet.configPage.actions.previewRoute(event); });
  const oldPreview = {
    route: "primary", compaction_mode: null, detection_source: "path", method: "POST", path: "/v1/responses",
    upstream_url: "https://old.synthetic.invalid/v1/responses", upstream_host: "old.synthetic.invalid",
    ingress_protocol: "openai_responses", upstream_protocol: "openai_responses", translation_mode: "passthrough",
    source_model: "synthetic", target_model: "synthetic", body_rewritten: false, stream_removed: false
  };
  if (!inFlight) {
    await act(async () => resolvePreview(Response.json(oldPreview)));
    expect(models().pageOutlet.routesPage.previewPanel.preview?.upstream_host).toBe("old.synthetic.invalid");
  }
  await store.patch({ primary: { base_url: "https://new.synthetic.invalid/v1" } });
  await act(async () => SyntheticEventSource.current.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({
    config: store.toPublicConfig(), health: { time: "new healthy" }, log_page: emptyLogPage(200), logs: []
  }) })));
  if (inFlight) await act(async () => resolvePreview(Response.json(oldPreview)));
  expect(models().pageOutlet.routesPage.config?.primary.host).toBe("new.synthetic.invalid");
  expect(models().pageOutlet.routesPage.previewPanel.preview).toBeNull();
});

it.each(["unchanged", "same-revision-snapshot", "draft-edit"])("keeps a preview for the current saved config: %s", async scenario => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/config") return Response.json(store.toPublicConfig());
    if (url === "/api/health") return Response.json({ time: "healthy" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url === "/api/test-route") return Response.json({ route: "primary", upstream_host: "unchanged.synthetic.invalid" });
    throw new Error(`Unexpected request: ${url}`);
  });
  const models = await mountModels();
  await act(async () => models().pageOutlet.configPage.actions.previewRoute(event));
  if (scenario === "same-revision-snapshot") {
    await act(async () => SyntheticEventSource.current.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({
      config: store.toPublicConfig(), health: { time: "new healthy" }, log_page: emptyLogPage(200), logs: []
    }) })));
  } else if (scenario === "draft-edit") {
    await act(async () => models().pageOutlet.configPage.onFormChange(form => ({ ...form, codexPrimaryBaseUrl: "https://draft.synthetic.invalid" })));
  }
  expect(models().pageOutlet.routesPage.previewPanel.preview?.upstream_host).toBe("unchanged.synthetic.invalid");
});

it.each([200, 503])("cancels stale previews across A/B/A and ignores late status %s", async status => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const configA = store.toPublicConfig();
  const pending: Array<{ signal: AbortSignal; finish: (response: Response) => void }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return Response.json(configA);
    if (url === "/api/health") return Response.json({ time: "healthy" });
    if (url.startsWith("/api/logs/recent?")) return Response.json(emptyLogPage(200));
    if (url === "/api/test-route") return new Promise<Response>(finish => pending.push({ signal: init!.signal!, finish }));
    throw new Error(`Unexpected request: ${url}`);
  });
  const models = await mountModels();
  await act(async () => { void models().pageOutlet.configPage.actions.previewRoute(event); });
  await store.patch({ primary: { base_url: "https://new.synthetic.invalid" } });
  for (const config of [store.toPublicConfig(), configA]) {
    await act(async () => SyntheticEventSource.current.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({
      config, health: { time: "new healthy" }, log_page: emptyLogPage(200), logs: []
    }) })));
  }
  expect(pending[0].signal.aborted).toBe(true);
  expect(models().pageOutlet.routesPage.previewPanel.isPreviewing).toBe(false);
  await act(async () => pending[0].finish(Response.json(status === 200
    ? { route: "primary", upstream_host: "stale.synthetic.invalid" } : { error: "Old preview failed" }, { status })));
  expect(models().pageOutlet.routesPage.previewPanel.preview).toBeNull();
  expect(models().pageOutlet.routesPage.previewPanel.previewError).toBeNull();
  await act(async () => { void models().pageOutlet.configPage.actions.previewRoute(event); });
  await act(async () => pending[1].finish(Response.json({ route: "primary", upstream_host: "current.synthetic.invalid" })));
  expect(models().pageOutlet.routesPage.previewPanel.preview?.upstream_host).toBe("current.synthetic.invalid");
});
