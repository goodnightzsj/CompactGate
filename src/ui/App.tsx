import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PageMode, StudioPage } from "./app-types.js";
import { ConfirmProfileDeleteDialog } from "./config/ConfirmProfileDeleteDialog.js";
import { ConfigPage } from "./config/ConfigPage.js";
import {
  isFormDirty,
  renderLinkedModel
} from "./config/config-form-state.js";
import type { ConfigTab } from "./config/types.js";
import { DashboardPage } from "./dashboard/DashboardPage.js";
import { HealthPage } from "./health/HealthPage.js";
import { useConfigActions } from "./hooks/useConfigActions.js";
import { useDocumentTitle } from "./hooks/useDocumentTitle.js";
import { useHealthRefresh } from "./hooks/useHealthRefresh.js";
import { useLogFeed } from "./hooks/useLogFeed.js";
import { useStudioBootstrap } from "./hooks/useStudioBootstrap.js";
import { useThemeMode } from "./hooks/useThemeMode.js";
import { StudioSidebar } from "./layout/StudioSidebar.js";
import { LogsPage } from "./logs/LogsPage.js";
import { DEFAULT_LOG_PAGE_LIMIT } from "./logs/log-utils.js";
import {
  detectPage,
  pagePathForStudioPage,
  subscribePageChanges
} from "./routing.js";
import { RoutesPage } from "./routes/RoutesPage.js";
import "./styles.css";

function App() {
  const [pageMode, setPageMode] = useState<PageMode>(() => detectPage());
  const healthMode = pageMode === "health";
  const [currentPage, setCurrentPage] = useState<StudioPage>(
    healthMode ? "dashboard" : pageMode as StudioPage
  );
  const { config, setConfig, health, setHealth, form, setForm, pageError, setPageError } =
    useStudioBootstrap(pageMode);
  const [currentModel, setCurrentModel] = useState("gpt-5.5");
  const [themeMode, setThemeMode] = useThemeMode();
  const [configTab, setConfigTab] = useState<ConfigTab>("profiles");

  const hasConfig = config !== null;
  const logPageLimit = config?.logging.keep_recent ?? DEFAULT_LOG_PAGE_LIMIT;
  const {
    logPage,
    routeFilter,
    setRouteFilter,
    statusFilter,
    setStatusFilter,
    hostFilter,
    setHostFilter,
    hostOptions,
    logError,
    isLoadingLogs,
    isLoadingMoreLogs,
    loadMoreLogs
  } = useLogFeed({
    enabled: !healthMode,
    hasConfig,
    logPageLimit,
    setConfig,
    setHealth
  });
  const { isRefreshingHealth, refreshHealth } = useHealthRefresh({
    enabled: healthMode,
    setHealth,
    setPageError
  });
  const logs = logPage.logs;
  const latestLog = logs[0] ?? null;
  const linkedCompactModel = renderLinkedModel(currentModel, form.modelTemplate);
  const {
    applySelectedProfile,
    claudeProfileError,
    claudeProfileName,
    claudeProfileState,
    confirmDeleteSelectedProfile,
    duplicateSelectedProfile,
    exportConfig,
    importConfig,
    preview,
    previewBody,
    previewError,
    previewPath,
    previewRoute,
    profileDeleteCandidate,
    profileError,
    profileName,
    profileState,
    reorderProfiles,
    requestDeleteSelectedProfile,
    restoreLinkedMode,
    saveConfig,
    saveConfigProfile,
    saveError,
    saveState,
    selectConfigProfile,
    selectedClaudeProfileId,
    selectedProfileId,
    setClaudeProfileName,
    setPreviewBody,
    setPreviewPath,
    setProfileDeleteCandidate,
    setProfileName,
    unlockCompactModel,
    updateSelectedProfile
  } = useConfigActions({
    config,
    form,
    linkedCompactModel,
    setConfig,
    setForm,
    setHealth,
    setPageError
  });
  const effectiveCompactModel =
    form.modelMode === "linked" ? linkedCompactModel : form.modelOverride || "手动模型";
  const activeRoute = preview?.route ?? latestLog?.route ?? "compact";
  const hasPendingChanges = useMemo(() => {
    return config ? isFormDirty(config, form) : false;
  }, [config, form]);
  const logCounts = logPage.counts;
  useDocumentTitle(pageMode);

  const applyPageMode = (nextPageMode: PageMode) => {
    setPageMode(nextPageMode);
    setCurrentPage(nextPageMode === "health" ? "dashboard" : nextPageMode);
  };

  useEffect(() => subscribePageChanges(applyPageMode), []);

  useEffect(() => {
    if (latestLog?.source_model) {
      setCurrentModel(latestLog.source_model);
    }
  }, [latestLog?.source_model]);

  function navigateTo(page: StudioPage) {
    applyPageMode(page);
    window.history.replaceState(null, "", pagePathForStudioPage(page));
  }

  if (healthMode) {
    return (
      <div className="app-shell">
        <StudioSidebar currentPage="dashboard" onNavigate={navigateTo} health={health} themeMode={themeMode} onThemeModeChange={setThemeMode} />
        <main className="main-content">
          <HealthPage health={health} error={pageError} isRefreshing={isRefreshingHealth} onRefresh={refreshHealth} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <StudioSidebar currentPage={currentPage} onNavigate={navigateTo} health={health} themeMode={themeMode} onThemeModeChange={setThemeMode} />

      <main className="main-content">
        {pageError && <div className="error-banner">{pageError}</div>}

        {currentPage === "dashboard" && (
          <DashboardPage
            config={config}
            health={health}
            logs={logs}
            logCounts={logCounts}
            providerCounts={logPage.provider_counts}
            saveState={saveState}
            hasPendingChanges={hasPendingChanges}
            onExport={exportConfig}
          />
        )}

        {currentPage === "routes" && (
          <RoutesPage
            config={config}
            currentModel={currentModel}
            compactModel={effectiveCompactModel}
            compactMode={form.upstreamMode}
            activeRoute={activeRoute}
            latestLog={latestLog}
          />
        )}

        {currentPage === "config" && (
          <ConfigPage
            config={config}
            form={form}
            currentModel={currentModel}
            linkedCompactModel={linkedCompactModel}
            saveState={saveState}
            saveError={saveError}
            profileName={profileName}
            selectedProfileId={selectedProfileId}
            profileState={profileState}
            profileError={profileError}
            claudeProfileName={claudeProfileName}
            selectedClaudeProfileId={selectedClaudeProfileId}
            claudeProfileState={claudeProfileState}
            claudeProfileError={claudeProfileError}
            hasPendingChanges={hasPendingChanges}
            previewPath={previewPath}
            previewBody={previewBody}
            preview={preview}
            previewError={previewError}
            configTab={configTab}
            onConfigTabChange={setConfigTab}
            onCurrentModelChange={setCurrentModel}
            onFormChange={setForm}
            onProfileNameChange={setProfileName}
            onClaudeProfileNameChange={setClaudeProfileName}
            onSelectedProfileChange={selectConfigProfile}
            onSaveProfile={saveConfigProfile}
            onApplyProfile={applySelectedProfile}
            onUpdateProfile={updateSelectedProfile}
            onReorderProfiles={reorderProfiles}
            onDuplicateProfile={duplicateSelectedProfile}
            onDeleteProfile={requestDeleteSelectedProfile}
            onUnlockCompactModel={unlockCompactModel}
            onRestoreLinkedMode={restoreLinkedMode}
            onPathChange={setPreviewPath}
            onBodyChange={setPreviewBody}
            onPreviewSubmit={previewRoute}
            onSaveConfig={saveConfig}
            onExportConfig={exportConfig}
            onImportConfig={importConfig}
          />
        )}

        {currentPage === "logs" && (
          <LogsPage
            logs={logs}
            logCounts={logCounts}
            providerCounts={logPage.provider_counts}
            statusCounts={logPage.status_counts}
            totalLogCount={logPage.total}
            allLogCount={logPage.all_total}
            hostOptions={hostOptions}
            hasMoreLogs={logPage.has_more}
            isLoadingLogs={isLoadingLogs}
            isLoadingMoreLogs={isLoadingMoreLogs}
            routeFilter={routeFilter}
            statusFilter={statusFilter}
            hostFilter={hostFilter}
            onRouteFilterChange={setRouteFilter}
            onStatusFilterChange={setStatusFilter}
            onHostFilterChange={setHostFilter}
            onLoadMore={loadMoreLogs}
            error={logError}
          />
        )}
      </main>

      {profileDeleteCandidate && (
        <ConfirmProfileDeleteDialog
          profile={profileDeleteCandidate.profile}
          isDeleting={(profileDeleteCandidate.scope === "codex" ? profileState : claudeProfileState) === "deleting"}
          onCancel={() => setProfileDeleteCandidate(null)}
          onConfirm={confirmDeleteSelectedProfile}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
