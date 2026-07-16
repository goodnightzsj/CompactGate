import type { PageMode, StudioPage } from "./app-types.js";
import {
  DEFAULT_CONFIG_TAB,
  isConfigTab
} from "./config/config-tabs.js";
import type { ConfigTab } from "./config/types.js";

interface LocationLike {
  pathname: string;
  hash: string;
}

export interface StudioLocation {
  pageMode: PageMode;
  configTab: ConfigTab;
}

interface PageChangeTarget {
  getLocation: () => LocationLike;
  addEventListener: (type: "hashchange" | "popstate", listener: () => void) => void;
  removeEventListener: (type: "hashchange" | "popstate", listener: () => void) => void;
}

export function detectPage(): PageMode {
  return detectPageFromLocation(window.location);
}

export function detectStudioLocation(): StudioLocation {
  return detectStudioLocationFromLocation(window.location);
}

export function detectPageFromLocation(location: LocationLike): PageMode {
  if (location.pathname === "/health") return "health";
  if (location.pathname === "/config" || location.pathname.startsWith("/config/")) {
    return "config";
  }
  const hash = location.hash.slice(1);
  if (hash === "routes" || hash === "config" || hash === "logs") return hash;
  return "dashboard";
}

export function detectConfigTabFromLocation(location: LocationLike): ConfigTab {
  const [, section, tab = ""] = location.pathname.split("/");
  return section === "config" && isConfigTab(tab) ? tab : DEFAULT_CONFIG_TAB;
}

export function detectStudioLocationFromLocation(location: LocationLike): StudioLocation {
  return {
    pageMode: detectPageFromLocation(location),
    configTab: detectConfigTabFromLocation(location)
  };
}

export function configPathForTab(tab: ConfigTab): string {
  return `/config/${tab}`;
}

export function pagePathForStudioPage(
  page: StudioPage,
  configTab: ConfigTab = DEFAULT_CONFIG_TAB
): string {
  if (page === "health") return "/health";
  if (page === "config") return configPathForTab(configTab);
  return page === "dashboard" ? "/" : `/#${page}`;
}

export function subscribePageChanges(
  onPageChange: (page: PageMode, configTab: ConfigTab) => void,
  target: PageChangeTarget = {
    getLocation: () => window.location,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener)
  }
): () => void {
  const handleChange = () => {
    const location = detectStudioLocationFromLocation(target.getLocation());
    onPageChange(location.pageMode, location.configTab);
  };

  target.addEventListener("hashchange", handleChange);
  target.addEventListener("popstate", handleChange);

  return () => {
    target.removeEventListener("hashchange", handleChange);
    target.removeEventListener("popstate", handleChange);
  };
}
