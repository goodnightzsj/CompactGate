import type { PageMode, StudioPage } from "./app-types.js";

interface LocationLike {
  pathname: string;
  hash: string;
}

interface PageChangeTarget {
  getLocation: () => LocationLike;
  addEventListener: (type: "hashchange" | "popstate", listener: () => void) => void;
  removeEventListener: (type: "hashchange" | "popstate", listener: () => void) => void;
}

export function detectPage(): PageMode {
  return detectPageFromLocation(window.location);
}

export function detectPageFromLocation(location: LocationLike): PageMode {
  if (location.pathname === "/health") return "health";
  const hash = location.hash.slice(1);
  if (hash === "routes" || hash === "config" || hash === "logs") return hash;
  return "dashboard";
}

export function pagePathForStudioPage(page: StudioPage): string {
  return page === "dashboard" ? "/" : `/#${page}`;
}

export function subscribePageChanges(
  onPageChange: (page: PageMode) => void,
  target: PageChangeTarget = {
    getLocation: () => window.location,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener)
  }
): () => void {
  const handleChange = () => onPageChange(detectPageFromLocation(target.getLocation()));

  target.addEventListener("hashchange", handleChange);
  target.addEventListener("popstate", handleChange);

  return () => {
    target.removeEventListener("hashchange", handleChange);
    target.removeEventListener("popstate", handleChange);
  };
}
