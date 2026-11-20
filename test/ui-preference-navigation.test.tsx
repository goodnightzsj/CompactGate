// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardPage } from "../src/ui/dashboard/DashboardPage.js";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("routes dashboard health details in-app, leaving modified clicks as ordinary links", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const navigate = vi.fn();
  try {
    await act(async () => root.render(<DashboardPage config={null} health={null} logs={[]} logCounts={null}
      logError={null} onRetryLogs={() => undefined} saveState="idle" hasPendingChanges
      onExport={() => undefined} onNavigate={navigate} />));
    const link = container.querySelector<HTMLAnchorElement>('.dashboard-health-summary-link[href="/health"]')!;
    const ordinary = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(ordinary));
    expect(ordinary.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("health");
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      const modified = new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true });
      // Prevent jsdom's navigation only after observing the application's decision.
      const observe = (event: Event) => { expect(event.defaultPrevented).toBe(false); event.preventDefault(); };
      document.addEventListener("click", observe, { once: true });
      await act(async () => link.dispatchEvent(modified));
    }
    expect(navigate).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
});
