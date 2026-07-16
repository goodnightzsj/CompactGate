import { useMemo } from "react";
import type { PageMode, StudioPage } from "../app-types.js";
import type { ConfigTab } from "../config/types.js";
import {
  isFormDirty,
  renderLinkedModel
} from "../config/config-form-state.js";
import { useConfigActions } from "../hooks/useConfigActions.js";
import { useHealthRefresh } from "../hooks/useHealthRefresh.js";
import { useLogFeed } from "../hooks/useLogFeed.js";
import { useStudioBootstrap } from "../hooks/useStudioBootstrap.js";
import { DEFAULT_LOG_PAGE_LIMIT } from "../logs/log-utils.js";
import type { HealthResponse } from "../../shared/types.js";
import type { ProfileDeleteDialogHostProps } from "./ProfileDeleteDialogHost.js";
import type { StudioPageOutletProps } from "./StudioPageOutlet.js";
import {
  buildConfigPageModel,
  buildDashboardPageModel,
  buildHealthPageModel,
  buildLogsPageModel,
  buildProfileDeleteDialogModel,
  buildRoutesPageModel
} from "./studioPageModelBuilders.js";

export function useStudioPageModels({
  currentPage,
  configTab,
  healthMode,
  pageMode,
  onConfigTabChange
}: {
  currentPage: StudioPage;
  configTab: ConfigTab;
  healthMode: boolean;
  pageMode: PageMode;
  onConfigTabChange: (tab: ConfigTab) => void;
}): {
  pageOutlet: StudioPageOutletProps;
  profileDeleteDialog: ProfileDeleteDialogHostProps | null;
  sidebarHealth: HealthResponse | null;
} {
  const {
    config,
    setConfig,
    health,
    setHealth,
    form,
    setForm,
    draftRevision,
    applyRemoteConfig,
    commitConfig,
    pageError,
    setPageError
  } = useStudioBootstrap(pageMode);
  const hasConfig = config !== null;
  const logPageLimit = config?.logging.keep_recent ?? DEFAULT_LOG_PAGE_LIMIT;
  const logFeed = useLogFeed({
    enabled: !healthMode,
    hasConfig,
    logPageLimit,
    applyRemoteConfig,
    setHealth
  });
  const healthRefresh = useHealthRefresh({
    enabled: healthMode,
    setHealth,
    setPageError
  });
  const logs = logFeed.logPage.logs;
  const latestLog = logs[0] ?? null;
  const linkedCompactModel = renderLinkedModel(form.primaryModelOverride, form.modelTemplate);
  const configActions = useConfigActions({
    config,
    form,
    linkedCompactModel,
    draftRevision,
    commitConfig,
    setConfig,
    setForm,
    setHealth,
    setPageError
  });
  const effectiveCompactModel =
    form.modelMode === "linked" ? linkedCompactModel : form.modelOverride || "手动模型";
  const previewRoute = configActions.preview?.route ?? null;
  const hasPendingChanges = useMemo(() => {
    return config ? isFormDirty(config, form) : false;
  }, [config, form]);

  return {
    pageOutlet: {
      currentPage,
      healthMode,
      pageError,
      healthPage: buildHealthPageModel({
        health,
        healthRefresh,
        pageError
      }),
      dashboardPage: buildDashboardPageModel({
        config,
        configActions,
        hasPendingChanges,
        health,
        logFeed,
        logs
      }),
      routesPage: buildRoutesPageModel({
        compactModel: effectiveCompactModel,
        config,
        form,
        latestLog,
        previewRoute
      }),
      configPage: buildConfigPageModel({
        config,
        configActions,
        configTab,
        form,
        hasPendingChanges,
        linkedCompactModel,
        setForm,
        onConfigTabChange
      }),
      logsPage: buildLogsPageModel({
        logFeed,
        logs,
      })
    },
    profileDeleteDialog: buildProfileDeleteDialogModel({
      configActions,
      healthMode
    }),
    sidebarHealth: health
  };
}
