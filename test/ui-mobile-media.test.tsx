// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LogMobileCard } from "../src/ui/logs/LogMobileCard.js";
import { DashboardRecentRequests } from "../src/ui/dashboard/DashboardRecentRequests.js";
import type { RequestLogEntry } from "../src/shared/types.js";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it.each([false, true])("explains a failed HTTP 200 stream in the recent requests view (narrow=%s)", async narrow => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { media, matches: narrow }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const entry = { request_id: "fixture", status: 200, route: "primary", stream_outcome: "upstream_stream_error",
    error_summary: "Synthetic stream failure", time: "2026-11-18T00:00:00Z", completed_at: "2026-11-18T00:00:01Z",
    duration_ms: 1000, request_type: "stream" } as RequestLogEntry;
  try {
    await act(async () => root.render(<DashboardRecentRequests logs={[entry]} totalCount={1} listen="localhost:1" />));
    const trigger = container.querySelector<HTMLElement>("[aria-expanded]")!;
    expect(trigger.textContent).toMatch(/200\s*异常/);
    expect(trigger.getAttribute("aria-label") ?? trigger.textContent).toContain("异常");
    await act(async () => trigger.click());
    expect(container.querySelector("dl")?.textContent).toContain(entry.error_summary);
  } finally { await act(async () => root.unmount()); }
});
it("shares the parent's reduced-motion preference without per-card subscriptions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const subscriptions = vi.fn();
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: true, media,
    addEventListener: () => { if (media === "(prefers-reduced-motion: reduce)") subscriptions(); }, removeEventListener: () => undefined }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const logs = Array.from({ length: 200 }, (_, index) => ({ request_id: `synthetic-${index}`, route: "primary", status: 200,
    time: "2026-11-18T00:00:00Z", upstream_host: `host-${index}.invalid`, endpoint: "/responses", request_type: "http"
  } as RequestLogEntry));
  const render = (reduceMotion: boolean) => logs.map(entry => <LogMobileCard key={entry.request_id} entry={entry}
    logKey={entry.request_id} detailId={`detail-${entry.request_id}`} expanded={false} onToggle={() => undefined} reduceMotion={reduceMotion} />);
  try {
    await act(async () => root.render(render(true)));
    expect(container.querySelectorAll(".log-mobile-card")).toHaveLength(200);
    expect(container.textContent).toContain("host-199.invalid");
    expect(subscriptions).not.toHaveBeenCalled();
    await act(async () => root.render(render(false)));
    expect(subscriptions).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
