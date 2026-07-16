import { useEffect, useState } from "react";
import type { PageMode, StudioPage } from "../app-types.js";
import {
  detectPage,
  pagePathForStudioPage,
  subscribePageChanges
} from "../routing.js";

type StudioNavigationState = {
  pageMode: PageMode;
  currentPage: StudioPage;
};

function navigationStateFromPageMode(pageMode: PageMode): StudioNavigationState {
  return {
    pageMode,
    currentPage: pageMode
  };
}

export function useStudioNavigation() {
  const [navigation, setNavigation] = useState<StudioNavigationState>(() =>
    navigationStateFromPageMode(detectPage())
  );

  function applyPageMode(nextPageMode: PageMode) {
    setNavigation(navigationStateFromPageMode(nextPageMode));
  }

  function navigateTo(page: StudioPage) {
    applyPageMode(page);
    window.history.replaceState(null, "", pagePathForStudioPage(page));
  }

  useEffect(() => subscribePageChanges(applyPageMode), []);

  return {
    currentPage: navigation.currentPage,
    healthMode: navigation.currentPage === "health",
    navigateTo,
    pageMode: navigation.pageMode
  };
}

export type StudioNavigation = ReturnType<typeof useStudioNavigation>;
