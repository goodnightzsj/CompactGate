// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useThemeMode } from "../src/ui/hooks/useThemeMode.js";

function ThemeHarness() {
  const [mode, setMode] = useThemeMode();
  return <main><output>{mode}</output><button onClick={() => setMode("dark")}>dark</button></main>;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it.each(["SecurityError", "QuotaExceededError", "storage getter"])("keeps theme and UI alive when optional storage fails: %s", async (failure) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  const media = Object.assign(new EventTarget(), { matches: false });
  const add = vi.spyOn(media, "addEventListener"), remove = vi.spyOn(media, "removeEventListener");
  vi.stubGlobal("matchMedia", () => media);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const error = new DOMException("Synthetic unavailable storage", failure === "storage getter" ? "SecurityError" : failure);
  if (failure === "storage getter") vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw error; });
  else vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw error; });
  const meta = document.createElement("meta"); meta.name = "theme-color"; document.head.append(meta);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ThemeHarness />));
    expect(container.querySelector("main")).not.toBeNull();
    expect(container.querySelector("output")!.textContent).toBe("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.content).toBe("#faf8f3");
    expect(add).toHaveBeenCalledWith("change", expect.any(Function));
    media.matches = true;
    await act(async () => media.dispatchEvent(new Event("change")));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.content).toBe("#16181b");
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("output")!.textContent).toBe("dark");
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
    expect(warning).toHaveBeenCalledWith("Theme preference could not be saved.", error);
  } finally { await act(async () => root.unmount()); meta.remove(); }
});
