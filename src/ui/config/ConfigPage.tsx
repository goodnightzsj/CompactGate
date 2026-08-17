import type * as React from "react";
import type {
  PublicConfig
} from "../../shared/types.js";
import {
  ConfigImportExportPanel
} from "./ConfigImportExportPanel.js";
import { CONFIG_TABS } from "./config-tabs.js";
import { ConfigModelPanel } from "./ConfigModelPanel.js";
import { ConfigPreviewPanel } from "./ConfigPreviewPanel.js";
import { ConfigProfilesPanel } from "./ConfigProfilesPanel.js";
import { ConfigSaveBar } from "./ConfigSaveBar.js";
import { LoggingStoragePanel } from "./LoggingStoragePanel.js";
import { RouteConfigPanel } from "./RouteConfigPanel.js";
import { copyProfileRoutesToOtherDraft } from "./config-form-state.js";
import type { ConfigFormState, ConfigTab } from "./types.js";
import type { ConfigActions } from "../hooks/useConfigActions.js";
import { useConfigImportWorkflow } from "./useConfigImportWorkflow.js";

export function ConfigPage({
  actions,
  config,
  configTab,
  form,
  hasPendingChanges,
  linkedCompactModel,
  onFormChange,
  onConfigTabChange
}: {
  actions: ConfigActions;
  config: PublicConfig | null;
  configTab: ConfigTab;
  form: ConfigFormState;
  hasPendingChanges: boolean;
  linkedCompactModel: string;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
  onConfigTabChange: (tab: ConfigTab) => void;
}) {
  const importWorkflow = useConfigImportWorkflow({
    onImportConfig: actions.importConfig
  });

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">配置管理</p>
          <h2>配置管理</h2>
        </div>
      </div>

      <div className="config-layout">
        <div className="config-section">
          <div className="tab-bar config-tab-bar" role="tablist" aria-label="配置分类">
            {CONFIG_TABS.map((tabItem) => (
              <button
                type="button"
                role="tab"
                id={`config-tab-${tabItem.id}`}
                aria-controls={`config-panel-${tabItem.id}`}
                aria-selected={configTab === tabItem.id}
                key={tabItem.id}
                className={`config-tab ${configTab === tabItem.id ? "is-active" : ""}`}
                onClick={() => onConfigTabChange(tabItem.id)}
              >
                {tabItem.label}
              </button>
            ))}
          </div>

          <div
            id={`config-panel-${configTab}`}
            role="tabpanel"
            aria-labelledby={`config-tab-${configTab}`}
          >
            {configTab === "profiles" && (
              <ConfigProfilesPanel
                config={config}
                profileName={actions.profileName}
                selectedProfileId={actions.selectedProfileId}
                profileState={actions.profileState}
                profileError={actions.profileError}
                claudeProfileName={actions.claudeProfileName}
                selectedClaudeProfileId={actions.selectedClaudeProfileId}
                claudeProfileState={actions.claudeProfileState}
                claudeProfileError={actions.claudeProfileError}
                onProfileNameChange={actions.setProfileName}
                onClaudeProfileNameChange={actions.setClaudeProfileName}
                onSelectedProfileChange={actions.selectConfigProfile}
                onSaveProfile={actions.saveConfigProfile}
                onApplyProfile={actions.applySelectedProfile}
                onUpdateProfile={actions.updateSelectedProfile}
                onReorderProfiles={actions.reorderProfiles}
                onDuplicateProfile={actions.duplicateSelectedProfile}
                onCopyProfileRoutes={(profile) => onFormChange((previous) =>
                  copyProfileRoutesToOtherDraft(previous, profile)
                )}
                onDeleteProfile={actions.requestDeleteSelectedProfile}
              />
            )}

            {configTab === "routes" && (
              <RouteConfigPanel config={config} form={form} onFormChange={onFormChange} />
            )}

            {configTab === "model" && (
              <ConfigModelPanel
                config={config}
                form={form}
                linkedCompactModel={linkedCompactModel}
                onFormChange={onFormChange}
                onUnlockCompactModel={actions.unlockCompactModel}
                onRestoreLinkedMode={actions.restoreLinkedMode}
              />
            )}

            {configTab === "logging" && (
              <LoggingStoragePanel form={form} onFormChange={onFormChange} />
            )}

            {configTab === "preview" && (
              <ConfigPreviewPanel
                previewPath={actions.previewPath}
                previewBody={actions.previewBody}
                previewHeaders={actions.previewHeaders}
                preview={actions.preview}
                previewError={actions.previewError}
                onPathChange={actions.setPreviewPath}
                onBodyChange={actions.setPreviewBody}
                onHeadersChange={actions.setPreviewHeaders}
                onPreviewSubmit={actions.previewRoute}
              />
            )}

            {configTab === "portable" && (
              <ConfigImportExportPanel
                config={config}
                importCandidate={importWorkflow.importCandidate}
                importState={importWorkflow.importState}
                importError={importWorkflow.importError}
                onFileChange={importWorkflow.handleImportFileChange}
                onExportConfig={actions.exportConfig}
                onConfirmImport={importWorkflow.confirmImportConfig}
                onClearImport={importWorkflow.clearImportCandidate}
              />
            )}
          </div>
        </div>

        <ConfigSaveBar
          config={config}
          saveState={actions.saveState}
          saveError={actions.saveError}
          hasPendingChanges={hasPendingChanges}
          onSaveConfig={actions.saveConfig}
          onSaveProfileAsNew={actions.saveConfigProfile}
        />
      </div>
    </>
  );
}
