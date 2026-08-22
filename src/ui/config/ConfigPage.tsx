import { useState, type Dispatch, type SetStateAction } from "react";
import type {
  ConfigProfileScope,
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
import { ConfigSaveAsNewProfileDialog } from "./ConfigSaveAsNewProfileDialog.js";
import { LoggingStoragePanel } from "./LoggingStoragePanel.js";
import { RouteConfigPanel } from "./RouteConfigPanel.js";
import { copyProfileRoutesToOtherDraft } from "./config-form-state.js";
import {
  compactModeLabel,
  nextUniqueProfileName,
  profileScopeState,
  upstreamProtocolLabel
} from "./profile-utils.js";
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
  onFormChange: Dispatch<SetStateAction<ConfigFormState>>;
  onConfigTabChange: (tab: ConfigTab) => void;
}) {
  const [crossScopeDraft, setCrossScopeDraft] = useState<CrossScopeProfileDraft | null>(null);
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
                onCreateProfileForOtherScope={(profile) => {
                  setCrossScopeDraft({
                    sourceProfile: profile,
                    targetScope: profile.scope === "codex" ? "claude" : "codex",
                    form: copyProfileRoutesToOtherDraft(form, profile)
                  });
                }}
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
                onPreviewClear={actions.clearPreview}
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
          saveConflict={actions.saveConflict}
          hasPendingChanges={hasPendingChanges}
          onSaveConfig={actions.saveConfig}
          onOverrideSaveConflict={actions.overrideSaveConflict}
          onSaveProfileAsNew={actions.saveConfigProfile}
        />
      </div>

      {crossScopeDraft && (
        <CrossScopeProfileDialog
          config={config}
          draft={crossScopeDraft}
          onCancel={() => setCrossScopeDraft(null)}
          onConfirm={async (scope, name) => {
            const ok = await actions.saveConfigProfile(scope, name, crossScopeDraft.form);
            if (ok !== false) {
              setCrossScopeDraft(null);
              return true;
            }
            return false;
          }}
        />
      )}
    </>
  );
}

type CrossScopeProfileDraft = {
  sourceProfile: PublicConfig["profiles"][number];
  targetScope: ConfigProfileScope;
  form: ConfigFormState;
};

function CrossScopeProfileDialog({
  config,
  draft,
  onCancel,
  onConfirm
}: {
  config: PublicConfig | null;
  draft: CrossScopeProfileDraft;
  onCancel: () => void;
  onConfirm: (scope: ConfigProfileScope, name: string) => void | Promise<boolean>;
}) {
  const targetLabel = draft.targetScope === "codex" ? "Codex" : "Claude";
  const existingNames = config
    ? profileScopeState(config, draft.targetScope).profiles.map((profile) => profile.name)
    : [];
  const suggestedName = nextUniqueProfileName(draft.sourceProfile.name, existingNames);
  const routes = crossScopeRoutePreview(draft);

  return (
    <ConfigSaveAsNewProfileDialog
      config={config}
      initialName={suggestedName}
      initialScope={draft.targetScope}
      scopeLocked
      title={`创建为 ${targetLabel} 档案`}
      description={`将「${draft.sourceProfile.name}」的路由映射到 ${targetLabel}。上游协议保持源值，以决定直通或协议转换；不复制源凭据，目标端专属设置及现有凭据保持不变。`}
      submitLabel={`创建 ${targetLabel} 档案`}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="config-preview-result cross-scope-profile-preview" aria-label="待创建档案路由预览">
        <div className="cross-scope-route">
          <span>主路由</span>
          <strong>{routes.primaryUrl || "未配置"}</strong>
          <small>{upstreamProtocolLabel(routes.primaryProtocol)}</small>
        </div>
        <div className="cross-scope-route">
          <span>压缩路由</span>
          <strong>{routes.compactUrl || "未配置"}</strong>
          <small>
            {upstreamProtocolLabel(routes.compactProtocol)} · {compactModeLabel(routes.compactMode)}
          </small>
        </div>
      </div>
    </ConfigSaveAsNewProfileDialog>
  );
}

function crossScopeRoutePreview(draft: CrossScopeProfileDraft) {
  if (draft.targetScope === "codex") {
    return {
      primaryUrl: draft.form.codexPrimaryBaseUrl,
      primaryProtocol: draft.form.codexPrimaryUpstreamProtocol,
      compactUrl: draft.form.codexCompactBaseUrl,
      compactProtocol: draft.form.codexCompactUpstreamProtocol,
      compactMode: draft.form.upstreamMode
    };
  }

  return {
    primaryUrl: draft.form.claudePrimaryBaseUrl,
    primaryProtocol: draft.form.claudePrimaryUpstreamProtocol,
    compactUrl: draft.form.claudeCompactBaseUrl,
    compactProtocol: draft.form.claudeCompactUpstreamProtocol,
    compactMode: draft.form.claudeCompactUpstreamMode
  };
}
