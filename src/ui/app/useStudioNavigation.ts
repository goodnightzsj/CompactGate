import { useEffect, useState } from "react";
import type { PageMode, StudioPage } from "../app-types.js";
import type { ConfigTab } from "../config/types.js";
import {
  detectStudioLocation,
  pagePathForStudioPage,
  subscribePageChanges
} from "../routing.js";

export type StudioNavigationState = {
  pageMode: PageMode;
  currentPage: StudioPage;
  configTab: ConfigTab;
};

type StudioNavigationAction =
  | { type: "page"; page: StudioPage }
  | { type: "tab"; configTab: ConfigTab }
  | { type: "location"; pageMode: PageMode; configTab: ConfigTab };

type StudioNavigationPlan = {
  state: StudioNavigationState;
  pushPath: string | null;
};

function navigationStateFromLocation(
  pageMode: PageMode,
  configTab: ConfigTab
): StudioNavigationState {
  return {
    pageMode,
    currentPage: pageMode,
    configTab
  };
}

export function planStudioNavigation(
  current: StudioNavigationState,
  action: StudioNavigationAction
): StudioNavigationPlan {
  if (action.type === "location") {
    const configTab = action.pageMode === "config" ? action.configTab : current.configTab;
    if (current.pageMode === action.pageMode && current.configTab === configTab) {
      return { state: current, pushPath: null };
    }

    return {
      state: navigationStateFromLocation(action.pageMode, configTab),
      pushPath: null
    };
  }

  const page = action.type === "tab" ? "config" : action.page;
  const configTab = action.type === "tab" ? action.configTab : current.configTab;
  if (current.currentPage === page && current.configTab === configTab) {
    return { state: current, pushPath: null };
  }

  return {
    state: navigationStateFromLocation(page, configTab),
    pushPath: pagePathForStudioPage(page, configTab)
  };
}

export function useStudioNavigation() {
  const [navigation, setNavigation] = useState<StudioNavigationState>(() => {
    const location = detectStudioLocation();
    return navigationStateFromLocation(location.pageMode, location.configTab);
  });

  function applyPlan(plan: StudioNavigationPlan) {
    if (plan.state === navigation) {
      return;
    }

    setNavigation(plan.state);
    if (plan.pushPath) {
      window.history.pushState(null, "", plan.pushPath);
    }
  }

  function navigateTo(page: StudioPage) {
    applyPlan(planStudioNavigation(navigation, { type: "page", page }));
  }

  function navigateToConfigTab(configTab: ConfigTab) {
    applyPlan(planStudioNavigation(navigation, { type: "tab", configTab }));
  }

  useEffect(() => subscribePageChanges((pageMode, configTab) => {
    setNavigation((current) => planStudioNavigation(current, {
      type: "location",
      pageMode,
      configTab
    }).state);
  }), []);

  return {
    currentPage: navigation.currentPage,
    configTab: navigation.configTab,
    healthMode: navigation.currentPage === "health",
    navigateTo,
    navigateToConfigTab,
    pageMode: navigation.pageMode
  };
}

export type StudioNavigation = ReturnType<typeof useStudioNavigation>;
