import { useState } from "react";
import type * as React from "react";
import type {
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig,
  RoutePreviewResponse
} from "../../shared/types.js";
import { errorSummary } from "../shared/api.js";
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

type ConfigPageModelProps = {
  currentModel: string;
  linkedCompactModel: string;
  onCurrentModelChange: (model: string) => void;
  onUnlockCompactModel: () => void;
  onRestoreLinkedMode: () => void;
};

type ConfigPageSaveProps = {
  saveState: SaveState;
  saveError: string | null;
  hasPendingChanges: boolean;
  onSaveConfig: (event: React.FormEvent) => void;
};

type ConfigPageProfileProps = {
  profileName: string;
  selectedProfileId: string;
  profileState: ProfileActionState;
  profileError: string | null;
  claudeProfileName: string;
  selectedClaudeProfileId: string;
  claudeProfileState: ProfileActionState;
  claudeProfileError: string | null;
  onProfileNameChange: (name: string) => void;
  onClaudeProfileNameChange: (name: string) => void;
  onSelectedProfileChange: (scope: ConfigProfileScope, profileId: string) => void;
  onSaveProfile: (scope: ConfigProfileScope) => void | Promise<void>;
  onApplyProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUpdateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onReorderProfiles: (scope: ConfigProfileScope, profileIds: string[]) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
};

type ConfigPagePreviewProps = {
  previewPath: string;
  previewBody: string;
  preview: RoutePreviewResponse | null;
  previewError: string | null;
  onPathChange: (path: string) => void;
  onBodyChange: (body: string) => void;
  onPreviewSubmit: (event: React.FormEvent) => void;
};

type ConfigPageTabProps = {
  configTab: ConfigTab;
  onConfigTabChange: (tab: ConfigTab) => void;
};

type ConfigPagePortableProps = {
  onExportConfig: () => void | Promise<void>;
  onImportConfig: (payload: CompactGateConfig) => void | Promise<void>;
};

type ConfigPageProps = {
  config: PublicConfig | null;
  form: ConfigFormState;
  model: ConfigPageModelProps;
  save: ConfigPageSaveProps;
  profiles: ConfigPageProfileProps;
  previewState: ConfigPagePreviewProps;
  tab: ConfigPageTabProps;
  portable: ConfigPagePortableProps;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
};

export function ConfigPage({
  config,
  form,
  model,
  save,
  profiles,
  previewState,
  tab,
  portable,
  onFormChange
}: ConfigPageProps) {
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
      await portable.onImportConfig(importCandidate.config);
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
        <span className={`status-pill ${save.hasPendingChanges ? "is-warn" : ""}`}>
          {saveLabel(save.saveState, save.hasPendingChanges, config?.last_saved_at)}
        </span>
      </div>

      <div className="config-layout">
        <div className="config-section">
          <div className="tab-bar">
            {CONFIG_TABS.map((tabItem) => (
              <button
                key={tabItem.id}
                className={tab.configTab === tabItem.id ? "is-active" : ""}
                onClick={() => tab.onConfigTabChange(tabItem.id)}
              >
                {tabItem.label}
              </button>
            ))}
          </div>

          {tab.configTab === "profiles" && (
            <ConfigProfilesPanel
              config={config}
              profileName={profiles.profileName}
              selectedProfileId={profiles.selectedProfileId}
              profileState={profiles.profileState}
              profileError={profiles.profileError}
              claudeProfileName={profiles.claudeProfileName}
              selectedClaudeProfileId={profiles.selectedClaudeProfileId}
              claudeProfileState={profiles.claudeProfileState}
              claudeProfileError={profiles.claudeProfileError}
              onProfileNameChange={profiles.onProfileNameChange}
              onClaudeProfileNameChange={profiles.onClaudeProfileNameChange}
              onSelectedProfileChange={profiles.onSelectedProfileChange}
              onSaveProfile={profiles.onSaveProfile}
              onApplyProfile={profiles.onApplyProfile}
              onUpdateProfile={profiles.onUpdateProfile}
              onReorderProfiles={profiles.onReorderProfiles}
              onDuplicateProfile={profiles.onDuplicateProfile}
              onDeleteProfile={profiles.onDeleteProfile}
            />
          )}

          {tab.configTab === "routes" && (
            <RouteConfigPanel config={config} form={form} onFormChange={onFormChange} />
          )}

          {tab.configTab === "model" && (
            <ConfigModelPanel
              form={form}
              currentModel={model.currentModel}
              linkedCompactModel={model.linkedCompactModel}
              onCurrentModelChange={model.onCurrentModelChange}
              onFormChange={onFormChange}
              onUnlockCompactModel={model.onUnlockCompactModel}
              onRestoreLinkedMode={model.onRestoreLinkedMode}
            />
          )}

          {tab.configTab === "preview" && (
            <ConfigPreviewPanel
              previewPath={previewState.previewPath}
              previewBody={previewState.previewBody}
              preview={previewState.preview}
              previewError={previewState.previewError}
              onPathChange={previewState.onPathChange}
              onBodyChange={previewState.onBodyChange}
              onPreviewSubmit={previewState.onPreviewSubmit}
            />
          )}

          {tab.configTab === "portable" && (
            <ConfigImportExportPanel
              config={config}
              importCandidate={importCandidate}
              importState={importState}
              importError={importError}
              onFileChange={handleImportFileChange}
              onExportConfig={portable.onExportConfig}
              onConfirmImport={confirmImportConfig}
              onClearImport={clearImportCandidate}
            />
          )}
        </div>

        <ConfigSaveBar
          config={config}
          saveState={save.saveState}
          saveError={save.saveError}
          hasPendingChanges={save.hasPendingChanges}
          onSaveConfig={save.onSaveConfig}
        />
      </div>
    </>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
