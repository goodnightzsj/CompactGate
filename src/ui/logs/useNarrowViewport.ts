import { useCallback, useSyncExternalStore } from "react";

// Matches the breakpoint at which logs.css swaps the desktop table for the
// stacked cards. Read reactively so a resize across the boundary switches the
// transition instead of keeping whichever one the first render happened to pick.
const NARROW_VIEWPORT_QUERY = "(max-width: 720px)";

export function useNarrowViewport(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(NARROW_VIEWPORT_QUERY);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_VIEWPORT_QUERY).matches,
    // Server render has no viewport; the desktop table is the wider default and
    // hydration re-reads the real value on the first commit.
    () => false
  );
}
