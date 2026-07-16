import { describe, expect, it, vi } from "vitest";
import {
  detectPageFromLocation,
  pagePathForStudioPage,
  subscribePageChanges
} from "../src/ui/routing.js";
import type { PageMode } from "../src/ui/app-types.js";

describe("UI routing helpers", () => {
  it.each([
    ["/health", "", "health"],
    ["/", "#routes", "routes"],
    ["/", "#config", "config"],
    ["/", "#logs", "logs"],
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
    expect(pagePathForStudioPage("config")).toBe("/#config");
    expect(pagePathForStudioPage("logs")).toBe("/#logs");
    expect(pagePathForStudioPage("health")).toBe("/health");
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

    const unsubscribe = subscribePageChanges((page) => observed.push(page), {
      getLocation: () => location,
      addEventListener,
      removeEventListener
    });

    location = { pathname: "/", hash: "#routes" };
    for (const listener of listeners.get("hashchange") ?? []) {
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
    expect(observed).toEqual(["routes", "health"]);
  });
});
