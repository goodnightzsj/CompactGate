import type { Dispatch, SetStateAction } from "react";
import type {
  HealthResponse,
  OpenAiCompactionMode,
  PublicConfig,
  RequestLogEntry,
  RouteKind
} from "../../shared/types.js";
import type { ConfigFormState, ConfigTab } from "../config/types.js";
import type { ConfigActions } from "../hooks/useConfigActions.js";
import type { useHealthRefresh } from "../hooks/useHealthRefresh.js";
import type { useLogFeed } from "../hooks/useLogFeed.js";
import type { ConfigWorkspaceProps } from "./ConfigWorkspace.js";
import type { ProfileDeleteDialogHostProps } from "./ProfileDeleteDialogHost.js";
import type { StudioPageOutletProps } from "./StudioPageOutlet.js";

type HealthRefresh = ReturnType<typeof useHealthRefresh>;
type LogFeed = ReturnType<typeof useLogFeed>;

export function buildHealthPageModel({
  health,
  healthRefresh,
  pageError
}: {
  health: HealthResponse | null;
  healthRefresh: HealthRefresh;
  pageError: string | null;
}): StudioPageOutletProps["healthPage"] {
  return {
    health,
    error: pageError,
    isRefreshing: healthRefresh.isRefreshingHealth,
    onRefresh: healthRefresh.refreshHealth
  };
}

export function buildDashboardPageModel({
  config,
  configActions,
  hasPendingChanges,
  health,
  logFeed,
  logs
}: {
  config: PublicConfig | null;
  configActions: ConfigActions;
  hasPendingChanges: boolean;
  health: HealthResponse | null;
  logFeed: LogFeed;
  logs: RequestLogEntry[];
}): StudioPageOutletProps["dashboardPage"] {
  return {
    config,
    health,
    logs,
    logCounts: logFeed.logPage.counts,
    saveState: configActions.saveState,
    hasPendingChanges,
    onExport: configActions.exportConfig
  };
}

export function buildRoutesPageModel({
  compactModel,
  config,
  form,
  health,
  latestLog,
  previewRoute,
  previewCompactionMode
}: {
  compactModel: string;
  config: PublicConfig | null;
  form: ConfigFormState;
  health: HealthResponse | null;
  latestLog: RequestLogEntry | null;
  previewRoute: RouteKind | null;
  previewCompactionMode: OpenAiCompactionMode | null;
}): StudioPageOutletProps["routesPage"] {
  const activeRoute = previewRoute ?? latestLog?.route ?? null;
  const activeCompactionMode = previewRoute ? previewCompactionMode : latestLog?.compaction_mode ?? null;

  return {
    config,
    currentModel: form.primaryModelOverride,
    compactModel,
    compactMode: form.upstreamMode,
    activeRoute,
    activeCompactionMode,
    activeRouteSource: previewRoute ? "preview" : latestLog ? "latest" : "none",
    latestLog,
    codexStatus: health?.codex ?? null
  };
}

export function buildConfigPageModel({
  config,
  configActions,
  configTab,
  form,
  hasPendingChanges,
  linkedCompactModel,
  setForm,
  onConfigTabChange
}: {
  config: PublicConfig | null;
  configActions: ConfigActions;
  configTab: ConfigTab;
  form: ConfigFormState;
  hasPendingChanges: boolean;
  linkedCompactModel: string;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
  onConfigTabChange: (tab: ConfigTab) => void;
}): ConfigWorkspaceProps {
  return {
    actions: configActions,
    config,
    configTab,
    form,
    hasPendingChanges,
    linkedCompactModel,
    onFormChange: setForm,
    onConfigTabChange
  };
}

export function buildLogsPageModel({
  logFeed,
  logs
}: {
  logFeed: LogFeed;
  logs: RequestLogEntry[];
}): StudioPageOutletProps["logsPage"] {
  return {
    logs,
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
    onRouteFilterChange: logFeed.setRouteFilter,
    onStatusFilterChange: logFeed.setStatusFilter,
    onHostFilterChange: logFeed.setHostFilter,
    onLoadMore: logFeed.loadMoreLogs,
    error: logFeed.logError
  };
}

export function buildProfileDeleteDialogModel({
  configActions,
  healthMode
}: {
  configActions: ConfigActions;
  healthMode: boolean;
}): ProfileDeleteDialogHostProps | null {
  return healthMode
    ? null
    : {
        candidate: configActions.profileDeleteCandidate,
        claudeProfileState: configActions.claudeProfileState,
        codexProfileState: configActions.profileState,
        onCancel: () => configActions.setProfileDeleteCandidate(null),
        onConfirm: configActions.confirmDeleteSelectedProfile
      };
}
