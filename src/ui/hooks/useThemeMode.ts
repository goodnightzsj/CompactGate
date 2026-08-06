import { useEffect, useState } from "react";
import type { ThemeMode } from "../app-types.js";

export function useThemeMode() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredThemeMode());

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme() {
      const resolvedTheme = themeMode === "auto" ? (media.matches ? "dark" : "light") : themeMode;
      root.dataset.themeMode = themeMode;
      root.dataset.theme = resolvedTheme;
      root.style.colorScheme = resolvedTheme;
      window.localStorage.setItem("compactgate-theme-mode", themeMode);
      updateThemeColorMeta(root, resolvedTheme);
    }

    applyTheme();

    if (themeMode !== "auto") {
      return undefined;
    }

    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode]);

  return [themeMode, setThemeMode] as const;
}

function updateThemeColorMeta(root: HTMLElement, resolvedTheme: "light" | "dark") {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    return;
  }

  const fallback = resolvedTheme === "dark" ? "#16181b" : "#faf8f3";
  const paper = getComputedStyle(root).getPropertyValue("--paper").trim();
  meta.setAttribute("content", paper || fallback);
}

function readStoredThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem("compactgate-theme-mode");
    return value === "light" || value === "dark" || value === "auto" ? value : "auto";
  } catch {
    return "auto";
  }
}
