// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LogsPage } from "../src/ui/logs/LogsPage.js";
import { ALL_HOSTS_FILTER } from "../src/ui/logs/log-utils.js";
import type { RequestLogEntry } from "../src/shared/types.js";

vi.mock("../src/ui/logs/useNarrowViewport.js", () => ({ useNarrowViewport: () => false, useMediaQuery: () => true }));
const noop = () => undefined;
class Observer {
  static instances: Observer[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) { Observer.instances.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  emit(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Observer.instances = []; document.body.replaceChildren(); });

it("keeps all loaded rows and searchable metadata, mounting heavy cells only near the viewport or focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("scrollTo", noop);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const logs = Array.from({ length: 120 }, (_, index) => ({
    request_id: `synthetic-${index}`, sequence: 120 - index, time: "2026-11-18T00:00:00Z", completed_at: "2026-11-18T00:00:01Z", route: "primary",
    source_model: "source-model", target_model: "target-model", response_model: "target-model", status: 200,
    upstream_host: `host-${index}.invalid`, endpoint: "responses", request_type: "http", key_name: "synthetic-key",
    duration_ms: 1000, first_token_ms: 100, input_tokens: 10, output_tokens: 2, total_tokens: 12,
    cached_input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null,
    cached_output_tokens: null, reasoning_tokens: null
  } as RequestLogEntry));
  const props: ComponentProps<typeof LogsPage> = {
    logs, logCounts: { all: 120, primary: 120, compact: 0, claude: 0 }, providerCounts: { all: 120, openai: 120, claude: 0 },
    statusCounts: { all: 120, normal: 120, error: 0 }, totalLogCount: 120, allLogCount: 120, hostOptions: [],
    hasMoreLogs: false, isLoadingLogs: false, isLoadingMoreLogs: false, hasStaleLogs: false,
    routeFilter: "all", statusFilter: "all", hostFilter: ALL_HOSTS_FILTER, searchFilter: "", error: null,
    onDrilldownChange: noop, onRouteFilterChange: noop, onStatusFilterChange: noop, onHostFilterChange: noop,
    onSearchFilterChange: noop, onLoadMore: noop, onRetryLogs: noop, onOpenSamples: noop
  };
  try {
    await act(async () => root.render(<LogsPage {...props} />));
    expect(container.querySelectorAll(".log-row")).toHaveLength(120);
    expect(container.querySelectorAll(".token-tooltip")).toHaveLength(0);
    expect(container.textContent).toContain("host-119.invalid");
    const row = container.querySelector<HTMLElement>('[data-log-id="synthetic-119"]')!;
    expect(row.querySelectorAll("td")).toHaveLength(12);
    const observer = Observer.instances.find(item => item.targets.has(row))!;
    expect(observer).toBeDefined();
    await act(async () => observer.emit(row, true));
    expect(row.querySelector(".token-tooltip")).not.toBeNull();
    await act(async () => row.focus());
    await act(async () => observer.emit(row, false));
    expect(document.activeElement).toBe(row);
    expect(row.querySelector(".token-tooltip")).not.toBeNull();
    const stringify = vi.spyOn(JSON, "stringify");
    await act(async () => root.render(<LogsPage {...props} isLoadingMoreLogs />));
    expect(stringify.mock.calls.some(([value]) => Array.isArray(value) && value[0] === logs[0])).toBe(false);
    stringify.mockRestore();
    expect(document.activeElement).toBe(row);
    await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(row.getAttribute("aria-expanded")).toBe("true");
    await act(async () => row.blur());
    expect(row.querySelector(".token-tooltip")).not.toBeNull();
    await act(async () => row.click());
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".token-tooltip")).toBeNull();
    expect(container.querySelectorAll(".log-row")).toHaveLength(120);
    await act(async () => root.render(<LogsPage {...props} logs={logs.map(entry => entry.request_id === "synthetic-119"
      ? { ...entry, status: 500, error_summary: "Synthetic updated failure" } : entry)} />));
    expect(container.querySelector('[data-log-id="synthetic-119"]')?.textContent).toContain("500");
  } finally { await act(async () => root.unmount()); }
  expect(Observer.instances.every(item => item.targets.size === 0)).toBe(true);
});
