import { useState } from "react";
import type * as React from "react";
import type {
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig,
  RoutePreviewResponse
} from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";
import {
  ConfigImportExportPanel
} from "./ConfigImportExportPanel.js";
import {
  summarizeConfigImport,
  type ImportCandidate,
  type ImportState
} from "./config-import-summary.js";
import { ConfigModelPanel } from "./ConfigModelPanel.js";
import { ConfigPreviewPanel } from "./ConfigPreviewPanel.js";
import { ConfigProfilesPanel } from "./ConfigProfilesPanel.js";
import { ConfigSaveBar } from "./ConfigSaveBar.js";
import { RouteConfigPanel } from "./RouteConfigPanel.js";
import { saveLabel } from "./save-state.js";
import type { ConfigFormState, ConfigTab, ProfileActionState, SaveState } from "./types.js";

export function ConfigPage({
  config, form, currentModel, linkedCompactModel, saveState, saveError,
  profileName, selectedProfileId, profileState, profileError,
  claudeProfileName, selectedClaudeProfileId, claudeProfileState, claudeProfileError,
  hasPendingChanges, previewPath, previewBody, preview, previewError, configTab,
  onConfigTabChange, onCurrentModelChange, onFormChange,
  onProfileNameChange, onClaudeProfileNameChange, onSelectedProfileChange,
  onSaveProfile, onApplyProfile, onUpdateProfile, onReorderProfiles, onDuplicateProfile, onDeleteProfile,
  onUnlockCompactModel, onRestoreLinkedMode,
  onPathChange, onBodyChange, onPreviewSubmit, onSaveConfig,
  onExportConfig, onImportConfig
}: {
  config: PublicConfig | null; form: ConfigFormState; currentModel: string;
  linkedCompactModel: string; saveState: SaveState; saveError: string | null;
  profileName: string; selectedProfileId: string; profileState: ProfileActionState;
  profileError: string | null; claudeProfileName: string; selectedClaudeProfileId: string;
  claudeProfileState: ProfileActionState; claudeProfileError: string | null;
  hasPendingChanges: boolean; previewPath: string; previewBody: string;
  preview: RoutePreviewResponse | null; previewError: string | null; configTab: ConfigTab;
  onConfigTabChange: (tab: ConfigTab) => void;
  onCurrentModelChange: (model: string) => void;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
  onProfileNameChange: (name: string) => void;
  onClaudeProfileNameChange: (name: string) => void;
  onSelectedProfileChange: (scope: ConfigProfileScope, profileId: string) => void;
  onSaveProfile: (scope: ConfigProfileScope) => void | Promise<void>;
  onApplyProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUpdateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onReorderProfiles: (scope: ConfigProfileScope, profileIds: string[]) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUnlockCompactModel: () => void; onRestoreLinkedMode: () => void;
  onPathChange: (path: string) => void; onBodyChange: (body: string) => void;
  onPreviewSubmit: (event: React.FormEvent) => void;
  onSaveConfig: (event: React.FormEvent) => void;
  onExportConfig: () => void | Promise<void>;
  onImportConfig: (payload: CompactGateConfig) => void | Promise<void>;
}) {
  const CONFIG_TABS: Array<{ id: ConfigTab; label: string }> = [
    { id: "profiles", label: "档案" },
    { id: "routes", label: "路由" },
    { id: "model", label: "模型" },
    { id: "preview", label: "预览" },
    { id: "portable", label: "导入导出" }
  ];
  const [importCandidate, setImportCandidate] = useState<ImportCandidate | null>(null);
  const [importState, setImportState] = useState<ImportState>("idle");
  const [importError, setImportError] = useState<string | null>(null);

  async function handleImportFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }

    setImportState("idle");
    setImportError(null);

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("导入文件必须是 JSON 对象。");
      }

      const nextConfig = parsed as unknown as CompactGateConfig;
      setImportCandidate({
        fileName: file.name,
        sizeBytes: file.size,
        config: nextConfig,
        summary: summarizeConfigImport(nextConfig)
      });
      setImportState("ready");
    } catch (error) {
      setImportCandidate(null);
      setImportState("error");
      setImportError(errorSummary(error));
    }
  }

  async function confirmImportConfig() {
    if (!importCandidate) {
      setImportState("error");
      setImportError("请先选择一个 compactgate JSON 配置文件。");
      return;
    }

    setImportState("importing");
    setImportError(null);

    try {
      await onImportConfig(importCandidate.config);
      setImportState("imported");
    } catch (error) {
      setImportState("error");
      setImportError(errorSummary(error));
    }
  }

  function clearImportCandidate() {
    setImportCandidate(null);
    setImportState("idle");
    setImportError(null);
  }

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">配置管理</p>
          <h2>配置管理</h2>
        </div>
        <span className={`status-pill ${hasPendingChanges ? "is-warn" : ""}`}>
          {saveLabel(saveState, hasPendingChanges, config?.last_saved_at)}
        </span>
      </div>

      <div className="config-layout">
        <div className="config-section">
          <div className="tab-bar">
            {CONFIG_TABS.map((tab) => (
              <button
                key={tab.id}
                className={configTab === tab.id ? "is-active" : ""}
                onClick={() => onConfigTabChange(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {configTab === "profiles" && (
            <ConfigProfilesPanel
              config={config}
              profileName={profileName}
              selectedProfileId={selectedProfileId}
              profileState={profileState}
              profileError={profileError}
              claudeProfileName={claudeProfileName}
              selectedClaudeProfileId={selectedClaudeProfileId}
              claudeProfileState={claudeProfileState}
              claudeProfileError={claudeProfileError}
              onProfileNameChange={onProfileNameChange}
              onClaudeProfileNameChange={onClaudeProfileNameChange}
              onSelectedProfileChange={onSelectedProfileChange}
              onSaveProfile={onSaveProfile}
              onApplyProfile={onApplyProfile}
              onUpdateProfile={onUpdateProfile}
              onReorderProfiles={onReorderProfiles}
              onDuplicateProfile={onDuplicateProfile}
              onDeleteProfile={onDeleteProfile}
            />
          )}

          {configTab === "routes" && (
            <RouteConfigPanel config={config} form={form} onFormChange={onFormChange} />
          )}

          {configTab === "model" && (
            <ConfigModelPanel
              form={form}
              currentModel={currentModel}
              linkedCompactModel={linkedCompactModel}
              onCurrentModelChange={onCurrentModelChange}
              onFormChange={onFormChange}
              onUnlockCompactModel={onUnlockCompactModel}
              onRestoreLinkedMode={onRestoreLinkedMode}
            />
          )}

          {configTab === "preview" && (
            <ConfigPreviewPanel
              previewPath={previewPath}
              previewBody={previewBody}
              preview={preview}
              previewError={previewError}
              onPathChange={onPathChange}
              onBodyChange={onBodyChange}
              onPreviewSubmit={onPreviewSubmit}
            />
          )}

          {configTab === "portable" && (
            <ConfigImportExportPanel
              config={config}
              importCandidate={importCandidate}
              importState={importState}
              importError={importError}
              onFileChange={handleImportFileChange}
              onExportConfig={onExportConfig}
              onConfirmImport={confirmImportConfig}
              onClearImport={clearImportCandidate}
            />
          )}
        </div>

        <ConfigSaveBar
          config={config}
          saveState={saveState}
          saveError={saveError}
          hasPendingChanges={hasPendingChanges}
          onSaveConfig={onSaveConfig}
        />
      </div>
    </>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
