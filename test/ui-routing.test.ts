import { describe, expect, it, vi } from "vitest";
import {
  configPathForTab,
  detectConfigTabFromLocation,
  detectPageFromLocation,
  detectStudioLocationFromLocation,
  pagePathForStudioPage,
  subscribePageChanges
} from "../src/ui/routing.js";
import { planStudioNavigation } from "../src/ui/app/useStudioNavigation.js";
import type { PageMode } from "../src/ui/app-types.js";
import type { ConfigTab } from "../src/ui/config/types.js";

describe("UI routing helpers", () => {
  it.each([
    ["/health", "", "health"],
    ["/", "#routes", "routes"],
    ["/", "#config", "config"],
    ["/", "#logs", "logs"],
    ["/config/profiles", "", "config"],
    ["/config/routes", "", "config"],
    ["/config/model", "", "config"],
    ["/config/logging", "", "config"],
    ["/config/preview", "", "config"],
    ["/config/portable", "", "config"],
    ["/", "", "dashboard"],
    ["/", "#unknown", "dashboard"]
  ] satisfies Array<[string, string, PageMode]>)(
    "detects %s%s as %s",
    (pathname, hash, expected) => {
      expect(detectPageFromLocation({ pathname, hash })).toBe(expected);
    }
  );

  it("builds stable studio page paths", () => {
    expect(pagePathForStudioPage("dashboard")).toBe("/");
    expect(pagePathForStudioPage("routes")).toBe("/#routes");
    expect(pagePathForStudioPage("config")).toBe("/config/profiles");
    expect(pagePathForStudioPage("config", "routes")).toBe("/config/routes");
    expect(pagePathForStudioPage("logs")).toBe("/#logs");
    expect(pagePathForStudioPage("health")).toBe("/health");
  });

  it("plans navigation without losing the current config tab or browser history", () => {
    const routesState = {
      pageMode: "config" as const,
      currentPage: "config" as const,
      configTab: "routes" as const
    };

    const repeated = planStudioNavigation(routesState, { type: "page", page: "config" });
    expect(repeated).toEqual({ state: routesState, pushPath: null });
    expect(repeated.state).toBe(routesState);

    const logs = planStudioNavigation(routesState, { type: "page", page: "logs" });
    expect(logs).toEqual({
      state: { pageMode: "logs", currentPage: "logs", configTab: "routes" },
      pushPath: "/#logs"
    });

    expect(planStudioNavigation(logs.state, { type: "page", page: "config" })).toEqual({
      state: { pageMode: "config", currentPage: "config", configTab: "routes" },
      pushPath: "/config/routes"
    });

    const modelTab = planStudioNavigation(routesState, { type: "tab", configTab: "model" });
    expect(modelTab).toEqual({
      state: { pageMode: "config", currentPage: "config", configTab: "model" },
      pushPath: "/config/model"
    });
    expect(planStudioNavigation(modelTab.state, { type: "tab", configTab: "model" })).toEqual({
      state: modelTab.state,
      pushPath: null
    });

    expect(planStudioNavigation(routesState, {
      type: "location",
      pageMode: "logs",
      configTab: "profiles"
    })).toEqual({
      state: { pageMode: "logs", currentPage: "logs", configTab: "routes" },
      pushPath: null
    });
  });

  it.each([
    ["profiles", "/config/profiles"],
    ["routes", "/config/routes"],
    ["model", "/config/model"],
    ["logging", "/config/logging"],
    ["preview", "/config/preview"],
    ["portable", "/config/portable"]
  ] satisfies Array<[ConfigTab, string]>) (
    "maps the %s config tab to its canonical path",
    (tab, expectedPath) => {
      expect(configPathForTab(tab)).toBe(expectedPath);
      expect(detectConfigTabFromLocation({ pathname: expectedPath, hash: "" })).toBe(tab);
      expect(detectStudioLocationFromLocation({ pathname: expectedPath, hash: "" })).toEqual({
        pageMode: "config",
        configTab: tab
      });
    }
  );

  it("keeps the legacy config hash and incomplete config paths on the profiles tab", () => {
    expect(detectStudioLocationFromLocation({ pathname: "/", hash: "#config" })).toEqual({
      pageMode: "config",
      configTab: "profiles"
    });
    expect(detectStudioLocationFromLocation({ pathname: "/config", hash: "" })).toEqual({
      pageMode: "config",
      configTab: "profiles"
    });
    expect(detectStudioLocationFromLocation({ pathname: "/config/unknown", hash: "" })).toEqual({
      pageMode: "config",
      configTab: "profiles"
    });
  });

  it("notifies mounted pages when browser location changes", () => {
    let location = { pathname: "/", hash: "" };
    const listeners = new Map<string, Array<() => void>>();
    const addEventListener = vi.fn((type: string, listener: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    });
    const removeEventListener = vi.fn((type: string, listener: () => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    });
    const observed: PageMode[] = [];
    const observedTabs: ConfigTab[] = [];

    const unsubscribe = subscribePageChanges((page, configTab) => {
      observed.push(page);
      observedTabs.push(configTab);
    }, {
      getLocation: () => location,
      addEventListener,
      removeEventListener
    });

    location = { pathname: "/", hash: "#routes" };
    for (const listener of listeners.get("hashchange") ?? []) {
      listener();
    }

    location = { pathname: "/config/model", hash: "" };
    for (const listener of listeners.get("popstate") ?? []) {
      listener();
    }

    location = { pathname: "/health", hash: "" };
    for (const listener of listeners.get("popstate") ?? []) {
      listener();
    }

    unsubscribe();
    location = { pathname: "/", hash: "#logs" };
    for (const listener of listeners.get("hashchange") ?? []) {
      listener();
    }

    expect(addEventListener).toHaveBeenCalledWith("hashchange", expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith("popstate", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("hashchange", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("popstate", expect.any(Function));
    expect(observed).toEqual(["routes", "config", "health"]);
    expect(observedTabs).toEqual(["profiles", "model", "profiles"]);
  });
});
