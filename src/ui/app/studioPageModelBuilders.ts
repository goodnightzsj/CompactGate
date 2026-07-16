import type { Dispatch, SetStateAction } from "react";
import type {
  HealthResponse,
  PublicConfig,
  RequestLogEntry,
  RouteKind
} from "../../shared/types.js";
import type { ConfigFormState } from "../config/types.js";
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
    providerCounts: logFeed.logPage.provider_counts,
    saveState: configActions.saveState,
    hasPendingChanges,
    onExport: configActions.exportConfig
  };
}

export function buildRoutesPageModel({
  activeRoute,
  compactModel,
  config,
  form,
  latestLog
}: {
  activeRoute: RouteKind;
  compactModel: string;
  config: PublicConfig | null;
  form: ConfigFormState;
  latestLog: RequestLogEntry | null;
}): StudioPageOutletProps["routesPage"] {
  return {
    config,
    currentModel: form.primaryModelOverride,
    compactModel,
    compactMode: form.upstreamMode,
    activeRoute,
    latestLog
  };
}

export function buildConfigPageModel({
  config,
  configActions,
  form,
  hasPendingChanges,
  linkedCompactModel,
  setForm
}: {
  config: PublicConfig | null;
  configActions: ConfigActions;
  form: ConfigFormState;
  hasPendingChanges: boolean;
  linkedCompactModel: string;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
}): ConfigWorkspaceProps {
  return {
    actions: configActions,
    config,
    form,
    hasPendingChanges,
    linkedCompactModel,
    onFormChange: setForm
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
    pageQueryKey: logFeed.pageQueryKey,
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
