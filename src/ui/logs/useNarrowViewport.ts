import { useCallback, useSyncExternalStore } from "react";

// Defaults to the logs.css breakpoint. Other layouts must pass their own CSS
// breakpoint so resizing always mounts the view that can actually be displayed.
const NARROW_VIEWPORT_QUERY = "(max-width: 720px)";

export function useNarrowViewport(query = NARROW_VIEWPORT_QUERY): boolean {
  return useMediaQuery(query);
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Server render has no viewport; the desktop table is the wider default and
    // hydration re-reads the real value on the first commit.
    () => false
  );
}
