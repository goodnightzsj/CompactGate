import { useMemo, useSyncExternalStore } from "react";
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
import { useStaggeredLogs } from "../logs/useStaggeredLogs.js";
import type { HealthResponse } from "../../shared/types.js";
import type { ProfileDeleteDialogHostProps } from "./ProfileDeleteDialogHost.js";
import type { StudioPageOutletProps } from "./StudioPageOutlet.js";

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
    formRevision,
    applyRemoteConfig,
    commitConfig,
    notifyServerRecovered,
    pageError,
    setPageError,
    retryBootstrap,
    rebaseFormRevision,
    bootstrapFailed
  } = useStudioBootstrap(pageMode);
  const hasConfig = config !== null;
  const logPageLimit = config?.logging.keep_recent ?? DEFAULT_LOG_PAGE_LIMIT;
  const logFeed = useLogFeed({
    enabled: !healthMode,
    hasConfig,
    logPageLimit,
    applyRemoteConfig,
    onServerRecovered: notifyServerRecovered,
    setHealth
  });
  const healthRefresh = useHealthRefresh({
    enabled: healthMode,
    setHealth,
    setPageError
  });
  const logs = logFeed.logPage.logs;
  const documentVisible = useSyncExternalStore(
    subscribeDocumentVisibility,
    readDocumentVisibility,
    readServerVisibility
  );
  const displayedLogs = useStaggeredLogs(
    logs,
    logFeed.pageQueryKey,
    logFeed.logSyncVersion,
    logFeed.liveInsertIds,
    currentPage === "logs" && !healthMode && documentVisible
  );
  const latestLog = logs[0] ?? null;
  const linkedCompactModel = renderLinkedModel(form.primaryModelOverride, form.modelTemplate);
  const configActions = useConfigActions({
    config,
    form,
    linkedCompactModel,
    draftRevision,
    formRevision,
    commitConfig,
    rebaseFormRevision,
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
  // The routes page describes what the proxy is doing right now, so it reads the
  // saved config rather than the draft. Feeding it the form mixed unsaved model
  // names with the saved hosts beside them and presented the result as the live
  // rules; `hasPendingChanges` is passed through so the page can say so.
  const savedCompactModel = useMemo(() => {
    if (!config) {
      return effectiveCompactModel;
    }
    return config.compact.model_mode === "linked"
      ? renderLinkedModel(config.primary.model_override ?? "", config.compact.model_template)
      : config.compact.model_override || "手动模型";
  }, [config, effectiveCompactModel]);

  return {
    pageOutlet: {
      currentPage,
      healthMode,
      pageError,
      onRetry: retryBootstrap,
      // Only the load path leaves stale data on screen; other page errors (a
      // failed export, say) sit over data that is perfectly current.
      hasStaleData: hasConfig && bootstrapFailed,
      healthPage: {
        health,
        error: pageError,
        isRefreshing: healthRefresh.isRefreshingHealth,
        onRefresh: healthRefresh.refreshHealth
      },
      dashboardPage: {
        config,
        health,
        logs,
        logCounts: logFeed.logPage.counts,
        saveState: configActions.saveState,
        hasPendingChanges,
        onExport: configActions.exportConfig
      },
      routesPage: {
        config,
        currentModel: config?.primary.model_override ?? form.primaryModelOverride,
        compactModel: savedCompactModel,
        compactMode: config?.compact.upstream_mode ?? form.upstreamMode,
        hasPendingChanges,
        activeRoute: previewRoute ?? latestLog?.route ?? null,
        activeCompactionMode: previewRoute
          ? configActions.preview?.compaction_mode ?? null
          : latestLog?.compaction_mode ?? null,
        activeRouteSource: previewRoute ? "preview" : latestLog ? "latest" : "none",
        latestLog,
        codexStatus: health?.codex ?? null
      },
      configPage: {
        actions: configActions,
        config,
        configTab,
        form,
        hasPendingChanges,
        linkedCompactModel,
        onFormChange: setForm,
        onConfigTabChange
      },
      logsPage: {
        logs: displayedLogs,
        logCounts: logFeed.logPage.counts,
        providerCounts: logFeed.logPage.provider_counts,
        statusCounts: logFeed.logPage.status_counts,
        totalLogCount: logFeed.logPage.total,
        allLogCount: logFeed.logPage.all_total,
        hostOptions: logFeed.hostOptions,
        hasMoreLogs: logFeed.logPage.has_more,
        isLoadingLogs: logFeed.isLoadingLogs,
        isLoadingMoreLogs: logFeed.isLoadingMoreLogs,
        routeFilter: logFeed.routeFilter,
        statusFilter: logFeed.statusFilter,
        hostFilter: logFeed.hostFilter,
        searchFilter: logFeed.searchFilter,
        onRouteFilterChange: logFeed.setRouteFilter,
        onStatusFilterChange: logFeed.setStatusFilter,
        onHostFilterChange: logFeed.setHostFilter,
        onSearchFilterChange: logFeed.setSearchFilter,
        onLoadMore: logFeed.loadMoreLogs,
        error: logFeed.logError
      }
    },
    profileDeleteDialog: healthMode
      ? null
      : {
          candidate: configActions.profileDeleteCandidate,
          claudeProfileError: configActions.claudeProfileError,
          claudeProfileState: configActions.claudeProfileState,
          codexProfileError: configActions.profileError,
          codexProfileState: configActions.profileState,
          onCancel: () => configActions.setProfileDeleteCandidate(null),
          onConfirm: configActions.confirmDeleteSelectedProfile
        },
    sidebarHealth: health
  };
}

function subscribeDocumentVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function readDocumentVisibility(): boolean {
  return document.visibilityState === "visible";
}

function readServerVisibility(): boolean {
  return true;
}
