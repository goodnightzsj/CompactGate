import { useEffect, useId, useRef, useState } from "react";
import type * as React from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type {
  ClaudeModelMap,
  ClaudeModelMapRole,
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig,
  RouteUrlPresetKind,
  RoutePreviewResponse
} from "../../shared/types.js";
import { CustomSelect, type SelectOption } from "../shared/CustomSelect.js";
import { api, errorSummary } from "../shared/api.js";
import { formatClock } from "../shared/format.js";
import { CLAUDE_MODEL_MAP_META, CLAUDE_MODEL_MAP_ROLES, normalizeClaudeModelMap } from "./model-map.js";
import {
  isProfileActionBusy,
  profileActionLabel,
  profileScopeState,
  profileSummary
} from "./profile-utils.js";
import { saveButtonLabel, saveLabel } from "./save-state.js";
import type { ConfigFormState, ConfigTab, ProfileActionState, ProfileDropPosition, SaveState } from "./types.js";

type PublicRouteCredentialConfig =
  | PublicConfig["primary"]
  | PublicConfig["compact"]
  | PublicConfig["claude"]["primary"]
  | PublicConfig["claude"]["compact"];

type ClaudeModelsResponse = { models: string[]; upstream_host: string; error: string | null };
type ImportState = "idle" | "ready" | "importing" | "imported" | "error";
type ImportCandidate = {
  fileName: string;
  sizeBytes: number;
  config: CompactGateConfig;
  summary: ConfigImportSummary;
};
type ConfigImportSummary = {
  listen: string;
  codexPrimaryHost: string;
  codexCompactHost: string;
  claudePrimaryHost: string;
  codexProfileCount: number;
  claudeProfileCount: number;
  presetCount: number;
  keepRecent: number | null;
  hasDirectApiKeys: boolean;
};

type ImportSummaryItem = {
  label: string;
  value: string;
  tone?: "warn";
};
type ProfileUrlSuggestion = {
  baseUrl: string;
  host: string;
  profileName: string;
  updatedAt: string;
};

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
  const applyTarget = activeProfileApplyTarget(config);
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
            <div className="profile-scope-grid">
              <ProfileScopeCard
                scope="codex" title="Codex 配置档案" eyebrow="Codex"
                description="保存、复制或应用 Codex 主路由与 compact 草稿，不会改动 Claude 档案。"
                emptyTitle="还没有保存的 Codex 档案"
                emptyDescription="填写名称后保存当前 Codex 草稿，就会在这里出现可应用的档案卡片。"
                config={config}
                profileName={profileName} selectedProfileId={selectedProfileId}
                profileState={profileState} profileError={profileError}
                onProfileNameChange={onProfileNameChange}
                onSelectedProfileChange={onSelectedProfileChange}
                onSaveProfile={onSaveProfile} onApplyProfile={onApplyProfile}
                onUpdateProfile={onUpdateProfile} onReorderProfiles={onReorderProfiles}
                onDuplicateProfile={onDuplicateProfile}
                onDeleteProfile={onDeleteProfile}
              />
              <ProfileScopeCard
                scope="claude" title="Claude 配置档案" eyebrow="Claude"
                description="保存、复制或应用 Claude 主路由与模型映射草稿，不会改动 Codex 档案。"
                emptyTitle="还没有保存的 Claude 档案"
                emptyDescription="填写名称后保存当前 Claude 草稿，就会在这里出现可应用的档案卡片。"
                config={config}
                profileName={claudeProfileName} selectedProfileId={selectedClaudeProfileId}
                profileState={claudeProfileState} profileError={claudeProfileError}
                onProfileNameChange={onClaudeProfileNameChange}
                onSelectedProfileChange={onSelectedProfileChange}
                onSaveProfile={onSaveProfile} onApplyProfile={onApplyProfile}
                onUpdateProfile={onUpdateProfile} onReorderProfiles={onReorderProfiles}
                onDuplicateProfile={onDuplicateProfile}
                onDeleteProfile={onDeleteProfile}
              />
            </div>
          )}

          {configTab === "routes" && (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="config-row">
                <RouteCredentialFields
                  title="Codex 主路由" badge="Codex" tone="primary"
                  baseUrlLabel="基础地址" baseUrlHint="普通 /v1 请求会转发到这里。"
                  apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Codex 主路由", config?.primary ?? null)}
                  baseUrl={form.codexPrimaryBaseUrl} apiKey={form.codexPrimaryApiKey}
                  storedApiKey={config?.primary.stored_api_key ?? false}
                  clearApiKey={form.clearCodexPrimaryApiKey}
                  profileUrlSuggestions={profileUrlSuggestions(config, "codex_primary")}
                  onBaseUrlChange={(value) => onFormChange((previous) => ({ ...previous, codexPrimaryBaseUrl: value }))}
                  onApiKeyChange={(value) => onFormChange((previous) => ({ ...previous, codexPrimaryApiKey: value, clearCodexPrimaryApiKey: false }))}
                  onToggleClearApiKey={() => onFormChange((previous) => ({ ...previous, codexPrimaryApiKey: "", clearCodexPrimaryApiKey: !previous.clearCodexPrimaryApiKey }))}
                />
                <RouteCredentialFields
                  title="Codex 压缩路由" badge="压缩" tone="compact"
                  baseUrlLabel="基础地址" baseUrlHint={form.upstreamMode === "split" ? "Codex 压缩请求会转发到这里。" : "当前复用 Codex 主路由。"}
                  apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Codex 压缩路由", config?.compact ?? null)}
                  baseUrl={form.codexCompactBaseUrl} apiKey={form.codexCompactApiKey}
                  storedApiKey={config?.compact.stored_api_key ?? false}
                  clearApiKey={form.clearCodexCompactApiKey}
                  profileUrlSuggestions={profileUrlSuggestions(config, "codex_compact")}
                  onBaseUrlChange={(value) => onFormChange((previous) => ({ ...previous, codexCompactBaseUrl: value }))}
                  onApiKeyChange={(value) => onFormChange((previous) => ({
                    ...previous,
                    codexCompactApiKey: value,
                    clearCodexCompactApiKey: false
                  }))}
                  onToggleClearApiKey={() => onFormChange((previous) => ({
                    ...previous,
                    codexCompactApiKey: "",
                    clearCodexCompactApiKey: !previous.clearCodexCompactApiKey
                  }))}
                />
              </div>
              <div className="config-row">
                <RouteCredentialFields
                  title="Claude 主路由" badge="Claude" tone="claude"
                  baseUrlLabel="基础地址" baseUrlHint="所有 Claude Code Messages 请求都会转发到这里。"
                  apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Claude 主路由", config?.claude.primary ?? null)}
                  baseUrl={form.claudePrimaryBaseUrl} apiKey={form.claudePrimaryApiKey}
                  storedApiKey={config?.claude.primary.stored_api_key ?? false}
                  clearApiKey={form.clearClaudePrimaryApiKey}
                  profileUrlSuggestions={profileUrlSuggestions(config, "claude_primary")}
                  onBaseUrlChange={(value) => onFormChange((previous) => ({ ...previous, claudePrimaryBaseUrl: value }))}
                  onApiKeyChange={(value) => onFormChange((previous) => ({ ...previous, claudePrimaryApiKey: value, clearClaudePrimaryApiKey: false }))}
                  onToggleClearApiKey={() => onFormChange((previous) => ({ ...previous, claudePrimaryApiKey: "", clearClaudePrimaryApiKey: !previous.clearClaudePrimaryApiKey }))}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                <div>
                  <div className="field-label" style={{ marginBottom: 4 }}>Codex 压缩上游模式</div>
                  <div className="toggle-group">
                    <button className={form.upstreamMode === "split" ? "is-active" : ""} onClick={() => onFormChange((previous) => ({ ...previous, upstreamMode: "split" }))}>独立分流</button>
                    <button className={form.upstreamMode === "primary" ? "is-active" : ""} onClick={() => onFormChange((previous) => ({ ...previous, upstreamMode: "primary" }))}>复用主路由</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {configTab === "model" && (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="field">
                <span className="field-label">当前 Codex 模型</span>
                <input className="input" value={currentModel} onChange={(event) => onCurrentModelChange(event.target.value)} spellCheck={false} />
                <span className="field-hint">可手动输入，也会从最近一次请求体自动学习。</span>
              </div>
              <ClaudeModelMapEditor
                modelMap={form.claudeModelMap}
                onModelMapChange={(role, value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    claudeModelMap: {
                      ...previous.claudeModelMap,
                      [role]: value
                    }
                  }))
                }
              />
              <div>
                <div className="field-label" style={{ marginBottom: 4 }}>压缩模型模式</div>
                <div className="toggle-group" style={{ marginBottom: 8 }}>
                  <button type="button" className={form.modelMode === "linked" ? "is-active" : ""} onClick={onRestoreLinkedMode}>自动联动</button>
                  <button type="button" className={form.modelMode === "custom" ? "is-active" : ""} onClick={onUnlockCompactModel}>手动指定</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                  <input
                    className="input"
                    value={form.modelMode === "linked" ? linkedCompactModel : form.modelOverride}
                    readOnly={form.modelMode === "linked"}
                    onChange={(event) => onFormChange((previous) => ({ ...previous, modelOverride: event.target.value }))}
                    spellCheck={false}
                  />
                  <button type="button" className="btn btn-sm" onClick={form.modelMode === "linked" ? onUnlockCompactModel : onRestoreLinkedMode}>
                    {form.modelMode === "linked" ? "解锁" : "恢复联动"}
                  </button>
                </div>
              </div>
              <div className="field">
                <span className="field-label">压缩模型联动模板</span>
                <input className="input" value={form.modelTemplate} onChange={(event) => onFormChange((previous) => ({ ...previous, modelTemplate: event.target.value }))} spellCheck={false} />
                <span className="field-hint">{`{model}`} 会被替换为请求中的原始模型名。</span>
              </div>
            </div>
          )}

          {configTab === "preview" && (
            <div style={{ display: "grid", gap: 12 }}>
              <div className="field">
                <span className="field-label">请求路径</span>
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <button type="button" className="btn btn-sm" onClick={() => onPathChange("/v1/responses")}>普通响应</button>
                  <button type="button" className="btn btn-sm" onClick={() => onPathChange("/v1/responses/compact")}>压缩响应</button>
                </div>
                <input className="input" value={previewPath} onChange={(event) => onPathChange(event.target.value)} />
              </div>
              <div className="field">
                <span className="field-label">JSON 请求体</span>
                <textarea className="textarea" value={previewBody} onChange={(event) => onBodyChange(event.target.value)} rows={4} spellCheck={false} style={{ resize: "vertical" }} />
              </div>
              {previewError && <div className="error-banner">{previewError}</div>}
              <button className="btn btn-primary" onClick={onPreviewSubmit}>预览路由</button>
              {preview && (
                <div style={{ padding: "12px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: "0.8rem" }}>
                  <div><span className="field-hint">路由</span><div><span className={`route-chip ${preview.route}`}>{routeLabel(preview.route)}</span></div></div>
                  <div><span className="field-hint">上游</span><div style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>{preview.upstream_host}</div></div>
                  <div><span className="field-hint">原始模型</span><div><code>{preview.source_model ?? "-"}</code></div></div>
                  <div><span className="field-hint">目标模型</span><div><code>{preview.target_model ?? "-"}</code></div></div>
                </div>
              )}
            </div>
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

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {saveError && <div className="error-banner" style={{ flex: 1 }}>{saveError}</div>}
          <span className="field-hint" style={{ flex: "1 1 260px" }}>{applyTarget.hint}</span>
          <button className="btn btn-primary" disabled={saveState === "saving"} onClick={onSaveConfig}>
            {saveButtonLabel(saveState, hasPendingChanges, applyTarget.savesActiveProfiles)}
          </button>
        </div>
      </div>
    </>
  );
}

function ClaudeModelMapEditor({
  modelMap,
  onModelMapChange
}: {
  modelMap: ClaudeModelMap;
  onModelMapChange: (role: ClaudeModelMapRole, value: string) => void;
}) {
  const inputIdPrefix = useId();
  const [models, setModels] = useState<string[]>([]);
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [fetchMeta, setFetchMeta] = useState<string | null>(null);

  async function fetchModels() {
    setFetchState("loading");
    setFetchMeta(null);

    try {
      const payload = await api<ClaudeModelsResponse>("/api/claude/models");
      setModels(payload.models);
      setFetchState(payload.error ? "error" : "loaded");
      setFetchMeta(
        payload.error
          ? `${payload.upstream_host}: ${payload.error}`
          : payload.models.length > 0
            ? `已从 ${payload.upstream_host} 读取 ${payload.models.length} 个模型。`
            : `${payload.upstream_host} 没有返回可用模型。`
      );
    } catch (error) {
      setFetchState("error");
      const message = errorSummary(error);
      setFetchMeta(
        message === "API endpoint not found."
          ? "后端模型接口尚未加载，请重启 CompactGate 服务后重试。"
          : message
      );
    }
  }

  const normalizedModelMap = normalizeClaudeModelMap(modelMap);
  const filledCount = CLAUDE_MODEL_MAP_ROLES.filter((role) => normalizedModelMap[role].trim().length > 0).length;
  const fallbackModel = normalizedModelMap.default.trim();
  const modelOptions = buildClaudeModelOptions(models);

  return (
    <section className="claude-model-map-card" aria-labelledby="claude-model-map-title">
      <div className="claude-model-map-head">
        <div>
          <p className="eyebrow">Claude 模型映射</p>
          <h3 id="claude-model-map-title">Claude 角色模型映射</h3>
          <p>
            切换 Claude 配置档案时，这里会覆盖普通会话、Opus、Sonnet、Haiku、推理和子代理的目标模型。
            未识别的请求会回退到默认槽位。
          </p>
        </div>
        <div className="claude-model-map-actions">
          <span className="map-counter">{filledCount}/6 已设置</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={fetchState === "loading"}
            onClick={() => void fetchModels()}
          >
            {fetchState === "loading" ? "读取中..." : "拉取模型"}
          </button>
        </div>
      </div>

      {fetchMeta && (
        <p className={`model-fetch-note ${fetchState === "error" ? "is-error" : ""}`}>{fetchMeta}</p>
      )}

      <div className="claude-model-map-grid">
        {CLAUDE_MODEL_MAP_ROLES.map((role) => {
          const meta = CLAUDE_MODEL_MAP_META[role];
          const value = normalizedModelMap[role];
          const inheritsDefault = role !== "default" && value.trim().length === 0 && fallbackModel.length > 0;
          const selectValue = models.includes(value) ? value : CUSTOM_MODEL_OPTION_VALUE;
          const inputId = `${inputIdPrefix}-${role}`;

          return (
            <div key={role} className={`claude-model-map-row ${role === "default" ? "is-default" : ""}`}>
              <span className="model-role-cell">
                <label htmlFor={inputId}>{meta.label}</label>
                <small>{meta.source}</small>
              </span>
              <span className="model-kind-cell">
                <span className={`tag ${meta.official ? "" : "is-compat"}`}>
                  {meta.official ? "官方" : "兼容"}
                </span>
                {inheritsDefault && <span className="tag is-fallback">回退默认</span>}
              </span>
              <div className="model-control-cell">
                <input
                  id={inputId}
                  aria-label={`Claude ${meta.label} 模型`}
                  className="input"
                  value={value}
                  placeholder={role === "default" ? "例如 claude-sonnet-4-6" : fallbackModel || "留空则使用默认槽位"}
                  onChange={(event) => onModelMapChange(role, event.target.value)}
                  spellCheck={false}
                />
                <CustomSelect
                  label="候选模型"
                  value={selectValue}
                  options={modelOptions}
                  onChange={(nextModel) => {
                    if (nextModel !== CUSTOM_MODEL_OPTION_VALUE) {
                      onModelMapChange(role, nextModel);
                    }
                  }}
                  disabled={models.length === 0}
                  compact
                  wide
                />
              </div>
              <small className="model-row-hint">{meta.hint}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const CUSTOM_MODEL_OPTION_VALUE = "__custom_model__";

function buildClaudeModelOptions(models: string[]): SelectOption[] {
  return [
    {
      value: CUSTOM_MODEL_OPTION_VALUE,
      label: models.length > 0 ? "手动输入" : "拉取后选择",
      meta: models.length > 0 ? "保留当前手动填写值" : "先点击上方“拉取模型”"
    },
    ...models.map((model) => ({
      value: model,
      label: model,
      meta: "来自当前 Claude 上游"
    }))
  ];
}

function activeProfileApplyTarget(config: PublicConfig | null): {
  savesActiveProfiles: boolean;
  hint: string;
} {
  if (!config) {
    return {
      savesActiveProfiles: false,
      hint: "配置加载完成后会显示本次应用会写入哪里。"
    };
  }

  const activeProfileLabels = (["codex", "claude"] as ConfigProfileScope[])
    .map((scope) => {
      const scopeState = profileScopeState(config, scope);
      const activeProfile = scopeState.profiles.find((profile) => profile.id === scopeState.active_profile_id);
      if (!activeProfile) {
        return null;
      }

      return `${scope === "codex" ? "Codex" : "Claude"} 档案「${activeProfile.name}」`;
    })
    .filter((label): label is string => label !== null);

  if (activeProfileLabels.length === 0) {
    return {
      savesActiveProfiles: false,
      hint: "只写入当前运行时；没有绑定档案时不会更新已保存档案。"
    };
  }

  return {
    savesActiveProfiles: true,
    hint: `会同步更新运行时和 ${activeProfileLabels.join("、")}。`
  };
}

function ConfigImportExportPanel({
  config,
  importCandidate,
  importState,
  importError,
  onFileChange,
  onExportConfig,
  onConfirmImport,
  onClearImport
}: {
  config: PublicConfig | null;
  importCandidate: ImportCandidate | null;
  importState: ImportState;
  importError: string | null;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onExportConfig: () => void | Promise<void>;
  onConfirmImport: () => void | Promise<void>;
  onClearImport: () => void;
}) {
  const fileInputId = useId();
  const summaryItems = importCandidate ? importSummaryItems(importCandidate.summary) : [];

  return (
    <section className="config-portable-panel" aria-labelledby="config-portable-title">
      <div className="config-portable-head">
        <div>
          <p className="eyebrow">Portable Config</p>
          <h3 id="config-portable-title">配置导入导出</h3>
          <p>
            导出当前配置为 compactgate JSON，或选择文件后先核对摘要，再确认覆盖当前运行时配置。
            URL 预设只包含地址元数据；导入摘要不会显示任何 API key 值。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!config}
          onClick={() => void onExportConfig()}
        >
          导出配置
        </button>
      </div>

      <div className="config-portable-grid">
        <div className="config-portable-card">
          <label className="config-file-drop" htmlFor={fileInputId}>
            <span>选择 compactgate.json</span>
            <strong>{importCandidate?.fileName ?? "尚未选择文件"}</strong>
            <small>
              {importCandidate
                ? `${formatBytes(importCandidate.sizeBytes)}，确认前不会写入。`
                : "本地解析后会显示覆盖摘要。"}
            </small>
          </label>
          <input
            id={fileInputId}
            className="config-file-input"
            type="file"
            accept="application/json,.json"
            onChange={onFileChange}
          />

          {importError && <div className="error-banner">{importError}</div>}
          {importState === "imported" && (
            <div className="inline-success" role="status">
              导入完成，当前运行时配置已经刷新。
            </div>
          )}
        </div>

        <div className="config-import-summary" aria-live="polite">
          {importCandidate ? (
            <>
              <div className="config-import-summary-head">
                <strong>即将导入的配置摘要</strong>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onClearImport}>
                  清除选择
                </button>
              </div>
              <dl className="config-import-summary-grid">
                {summaryItems.map((item) => (
                  <div key={item.label} className={item.tone === "warn" ? "is-warn" : ""}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="config-import-confirm">
                <p>
                  导入会把文件作为新的完整配置保存，缺失字段由默认值补齐。这个操作不会增加 URL 预设使用次数。
                </p>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={importState === "importing"}
                  onClick={() => void onConfirmImport()}
                >
                  {importState === "importing" ? "正在导入..." : "确认覆盖当前配置"}
                </button>
              </div>
            </>
          ) : (
            <div className="config-import-empty">
              <strong>先选择文件，再确认覆盖。</strong>
              <span>CompactGate 会先在浏览器中解析 JSON 并显示摘要；只有点击确认后才会写入后端配置文件。</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function importSummaryItems(summary: ConfigImportSummary): ImportSummaryItem[] {
  return [
    { label: "监听地址", value: summary.listen },
    { label: "Codex 主路由", value: summary.codexPrimaryHost },
    { label: "Codex 压缩路由", value: summary.codexCompactHost },
    { label: "Claude 主路由", value: summary.claudePrimaryHost },
    { label: "Codex 档案", value: `${summary.codexProfileCount}` },
    { label: "Claude 档案", value: `${summary.claudeProfileCount}` },
    { label: "URL 预设", value: `${summary.presetCount}` },
    { label: "保留日志", value: summary.keepRecent === null ? "默认或未声明" : `${summary.keepRecent} 条` },
    {
      label: "直填密钥",
      value: summary.hasDirectApiKeys ? "文件包含直填 API key；摘要已隐藏具体值。" : "未检测到直填 API key。",
      tone: summary.hasDirectApiKeys ? "warn" : undefined
    }
  ];
}

function summarizeConfigImport(config: CompactGateConfig): ConfigImportSummary {
  return {
    listen: typeof config.listen === "string" && config.listen.trim() ? config.listen.trim() : "默认或未声明",
    codexPrimaryHost: hostLabel(readNestedString(config, ["primary", "base_url"])),
    codexCompactHost: hostLabel(readNestedString(config, ["compact", "base_url"])),
    claudePrimaryHost: hostLabel(readNestedString(config, ["claude", "primary", "base_url"])),
    codexProfileCount: countProfiles(config, "codex"),
    claudeProfileCount: countProfiles(config, "claude"),
    presetCount: Array.isArray(config.route_url_presets) ? config.route_url_presets.length : 0,
    keepRecent: typeof config.logging?.keep_recent === "number" ? config.logging.keep_recent : null,
    hasDirectApiKeys: hasDirectApiKey(config)
  };
}

function countProfiles(config: CompactGateConfig, scope: ConfigProfileScope): number {
  const scopedProfiles = config.profile_scopes?.[scope]?.profiles;
  if (Array.isArray(scopedProfiles)) {
    return scopedProfiles.length;
  }

  return scope === "codex" && Array.isArray(config.profiles) ? config.profiles.length : 0;
}

function hasDirectApiKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasDirectApiKey);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([key, child]) => {
    if (key === "api_key") {
      return typeof child === "string" && child.trim().length > 0;
    }

    return hasDirectApiKey(child);
  });
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }

  return typeof current === "string" ? current : null;
}

function hostLabel(value: string | null): string {
  if (!value || !value.trim()) {
    return "默认或未声明";
  }

  try {
    return new URL(value).host;
  } catch {
    return "无效 URL";
  }
}

function profileUrlSuggestions(
  config: PublicConfig | null,
  kind: RouteUrlPresetKind
): ProfileUrlSuggestion[] {
  if (!config) {
    return [];
  }

  const scope: ConfigProfileScope = kind.startsWith("claude_") ? "claude" : "codex";
  const profiles = profileScopeState(config, scope).profiles;
  const seen = new Set<string>();
  const suggestions: ProfileUrlSuggestion[] = [];

  for (const profile of profiles) {
    const baseUrl = profileUrlForKind(profile, kind);
    if (!baseUrl) {
      continue;
    }

    const key = normalizeUrlSuggestionKey(baseUrl);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    suggestions.push({
      baseUrl,
      host: hostLabel(baseUrl),
      profileName: profile.name,
      updatedAt: profile.updated_at
    });
  }

  return suggestions;
}

function profileUrlForKind(
  profile: PublicConfig["profiles"][number],
  kind: RouteUrlPresetKind
): string | null {
  if (kind === "codex_primary") {
    return profile.primary_base_url;
  }

  if (kind === "codex_compact") {
    return profile.compact_base_url;
  }

  if (kind === "claude_primary") {
    return profile.claude_primary_base_url;
  }

  return profile.claude_compact_base_url;
}

function normalizeUrlSuggestionKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString().replace(/\/+$/g, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/g, "").toLowerCase();
  }
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ProfileScopeCard({
  scope,
  title,
  eyebrow,
  description,
  emptyTitle,
  emptyDescription,
  config,
  profileName,
  selectedProfileId,
  profileState,
  profileError,
  onProfileNameChange,
  onSelectedProfileChange,
  onSaveProfile,
  onApplyProfile,
  onUpdateProfile,
  onReorderProfiles,
  onDuplicateProfile,
  onDeleteProfile
}: {
  scope: ConfigProfileScope;
  title: string;
  eyebrow: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  config: PublicConfig | null;
  profileName: string;
  selectedProfileId: string;
  profileState: ProfileActionState;
  profileError: string | null;
  onProfileNameChange: (name: string) => void;
  onSelectedProfileChange: (scope: ConfigProfileScope, profileId: string) => void;
  onSaveProfile: (scope: ConfigProfileScope) => void | Promise<void>;
  onApplyProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUpdateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onReorderProfiles: (scope: ConfigProfileScope, profileIds: string[]) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
}) {
  const titleId = `${scope}-profile-card-title`;
  const scopeState = config ? profileScopeState(config, scope) : { profiles: [], active_profile_id: null };
  const profiles = scopeState.profiles;
  const activeProfile = profiles.find((profile) => profile.id === scopeState.active_profile_id) ?? null;
  const scopeLabel = scope === "codex" ? "Codex" : "Claude";
  const namedProfile = profiles.find((profile) => profile.name === profileName.trim()) ?? null;
  const saveWillApply = Boolean(namedProfile && namedProfile.id === scopeState.active_profile_id);
  const saveButtonText = profileState === "saving"
    ? saveWillApply ? "正在保存并应用..." : "正在保存档案..."
    : saveWillApply
      ? `保存并应用当前 ${scopeLabel} 草稿`
      : namedProfile
        ? `覆盖保存 ${scopeLabel} 档案`
        : `保存当前 ${scopeLabel} 草稿为新档案`;
  const profileNameHint = saveWillApply
    ? "名称命中当前运行时档案，保存后会立即应用到运行时。"
    : namedProfile
      ? "名称命中已有档案，保存后只覆盖档案，不切换当前运行时。"
      : "填写新名称会创建新档案，不会自动切换当前运行时。";
  const profileBusy = isProfileActionBusy(profileState);
  const profileListRef = useRef<HTMLDivElement | null>(null);
  const profileAutoScrollRef = useRef<{ frame: number | null; speed: number }>({
    frame: null,
    speed: 0
  });
  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ profileId: string; position: ProfileDropPosition } | null>(null);
  const canReorderProfiles = profiles.length > 1 && !profileBusy;

  useEffect(() => () => stopProfileAutoScroll(), []);

  function nextProfileOrder(
    draggedId: string,
    targetId: string,
    position: ProfileDropPosition
  ): string[] | null {
    if (draggedId === targetId) {
      return null;
    }

    const currentIds = profiles.map((profile) => profile.id);
    if (!currentIds.includes(draggedId) || !currentIds.includes(targetId)) {
      return null;
    }

    const withoutDragged = currentIds.filter((profileId) => profileId !== draggedId);
    const targetIndex = withoutDragged.indexOf(targetId);
    if (targetIndex < 0) {
      return null;
    }

    const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
    const nextIds = [...withoutDragged];
    nextIds.splice(insertIndex, 0, draggedId);

    return nextIds.every((profileId, index) => profileId === currentIds[index]) ? null : nextIds;
  }

  function dropPositionForEvent(event: React.DragEvent<HTMLElement>): ProfileDropPosition {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
  }

  function stopProfileAutoScroll() {
    const frame = profileAutoScrollRef.current.frame;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      profileAutoScrollRef.current.frame = null;
    }
    profileAutoScrollRef.current.speed = 0;
  }

  function runProfileAutoScroll() {
    const list = profileListRef.current;
    const speed = profileAutoScrollRef.current.speed;
    if (!list || speed === 0) {
      stopProfileAutoScroll();
      return;
    }

    const previousScrollTop = list.scrollTop;
    list.scrollTop += speed;
    if (list.scrollTop === previousScrollTop) {
      stopProfileAutoScroll();
      return;
    }

    profileAutoScrollRef.current.frame = window.requestAnimationFrame(runProfileAutoScroll);
  }

  function startProfileAutoScroll(speed: number) {
    profileAutoScrollRef.current.speed = speed;
    if (profileAutoScrollRef.current.frame === null) {
      profileAutoScrollRef.current.frame = window.requestAnimationFrame(runProfileAutoScroll);
    }
  }

  function updateProfileAutoScroll(event: React.DragEvent<HTMLElement>) {
    const list = profileListRef.current;
    if (!list || list.scrollHeight <= list.clientHeight) {
      stopProfileAutoScroll();
      return;
    }

    const bounds = list.getBoundingClientRect();
    const edgeSize = Math.min(112, Math.max(56, bounds.height * 0.42));
    const distanceFromTop = event.clientY - bounds.top;
    const distanceFromBottom = bounds.bottom - event.clientY;
    const maxSpeed = 8;

    if (distanceFromTop < edgeSize) {
      const intensity = 1 - Math.max(0, distanceFromTop) / edgeSize;
      startProfileAutoScroll(-Math.max(2, Math.round(maxSpeed * intensity * intensity)));
      return;
    }

    if (distanceFromBottom < edgeSize) {
      const intensity = 1 - Math.max(0, distanceFromBottom) / edgeSize;
      startProfileAutoScroll(Math.max(2, Math.round(maxSpeed * intensity * intensity)));
      return;
    }

    stopProfileAutoScroll();
  }

  function resetDragState() {
    stopProfileAutoScroll();
    setDraggedProfileId(null);
    setDropTarget(null);
  }

  function handleProfileDragStart(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (!canReorderProfiles) {
      event.preventDefault();
      return;
    }

    const card = event.currentTarget.closest(".profile-item") as HTMLElement | null;
    if (card) {
      const bounds = card.getBoundingClientRect();
      event.dataTransfer.setDragImage(card, event.clientX - bounds.left, event.clientY - bounds.top);
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", profileId);
    setDraggedProfileId(profileId);
    setDropTarget(null);
  }

  function handleProfileListDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!draggedProfileId || !canReorderProfiles) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateProfileAutoScroll(event);
  }

  function handleProfileListDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    stopProfileAutoScroll();
  }

  function handleProfileDragOver(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (!draggedProfileId || !canReorderProfiles) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateProfileAutoScroll(event);
    if (draggedProfileId === profileId) {
      setDropTarget(null);
      return;
    }

    setDropTarget({
      profileId,
      position: dropPositionForEvent(event)
    });
  }

  function handleProfileDragLeave(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setDropTarget((current) => current?.profileId === profileId ? null : current);
  }

  function handleProfileDrop(event: React.DragEvent<HTMLElement>, profileId: string) {
    event.preventDefault();

    const draggedId = draggedProfileId ?? event.dataTransfer.getData("text/plain");
    const position = dropTarget?.profileId === profileId
      ? dropTarget.position
      : dropPositionForEvent(event);
    const nextIds = nextProfileOrder(draggedId, profileId, position);

    resetDragState();
    if (nextIds) {
      void onReorderProfiles(scope, nextIds);
    }
  }

  return (
    <section className={`profile-card profile-card-${scope}`} aria-labelledby={titleId}>
      <div className="profile-card-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h3 id={titleId}>{title}</h3>
        <p>{description}</p>
      </div>

      <div className="profile-card-controls">
        <Field label={`${scopeLabel} 档案名称`} hint={profileNameHint}>
          <input
            aria-label={`${scopeLabel} 档案名称`}
            value={profileName}
            onChange={(event) => onProfileNameChange(event.target.value)}
            placeholder="选择档案后可在这里改名"
          />
        </Field>

        <button
          className="ghost-button profile-save-button"
          type="button"
          disabled={profileBusy}
          title={
            saveWillApply
              ? "保存当前草稿到当前运行时档案，并立即更新运行时。"
              : namedProfile
                ? "覆盖同名档案；不会切换当前运行时。"
                : "创建新档案；不会自动切换当前运行时。"
          }
          onClick={() => void onSaveProfile(scope)}
        >
          {saveButtonText}
        </button>
      </div>

      {profiles.length === 0 ? (
        <div className="profile-empty-card">
          <strong>{emptyTitle}</strong>
          <span>{emptyDescription}</span>
        </div>
      ) : (
        <div
          ref={profileListRef}
          className={`profile-list${draggedProfileId ? " is-reordering" : ""}`}
          aria-label={`已保存 ${scopeLabel} 配置档案`}
          onDragOver={handleProfileListDragOver}
          onDragLeave={handleProfileListDragLeave}
        >
          {profiles.map((profile) => {
            const isActive = profile.id === scopeState.active_profile_id;
            const isSelected = profile.id === selectedProfileId;
            const updateLabel = isActive ? "保存并应用" : "保存档案";
            const busyUpdateLabel = isActive ? "应用中..." : "保存中...";
            const cardClassName = [
              "profile-item",
              isActive ? "is-active" : "",
              isSelected ? "is-selected" : "",
              draggedProfileId === profile.id ? "is-dragging" : "",
              dropTarget?.profileId === profile.id ? `is-drop-${dropTarget.position}` : ""
            ].filter(Boolean).join(" ");

            return (
              <article
                key={profile.id}
                className={cardClassName}
                onDragOver={(event) => handleProfileDragOver(event, profile.id)}
                onDragLeave={(event) => handleProfileDragLeave(event, profile.id)}
                onDrop={(event) => handleProfileDrop(event, profile.id)}
              >
                <button
                  className="profile-item-handle"
                  type="button"
                  draggable={canReorderProfiles}
                  disabled={!canReorderProfiles}
                  aria-label={`拖动排序 ${profile.name}`}
                  tabIndex={-1}
                  title="拖动排序"
                  onDragStart={(event) => handleProfileDragStart(event, profile.id)}
                  onDragEnd={resetDragState}
                >
                  <span aria-hidden="true">≡</span>
                </button>
                <button
                  className="profile-item-main"
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectedProfileChange(scope, profile.id)}
                >
                  <span className="profile-item-icon" aria-hidden="true">
                    {profile.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="profile-item-copy">
                    <span className="profile-item-kicker">
                      {isActive ? "当前运行时" : isSelected ? "已选中" : "可选档案"}
                    </span>
                    <strong>{profile.name}</strong>
                    <small>{profileSummary(profile)}</small>
                    <span>更新于 {formatClock(profile.updated_at)}</span>
                  </span>
                </button>

                <div className="profile-item-actions">
                  <button
                    className="solid-button profile-apply-button"
                    type="button"
                    disabled={profileBusy || isActive}
                    data-active-disabled={isActive ? "true" : undefined}
                    title="把这个已保存档案加载到当前运行时；不会保存当前草稿。"
                    onClick={() => {
                      onSelectedProfileChange(scope, profile.id);
                      void onApplyProfile(scope, profile.id);
                    }}
                  >
                    {profileState === "applying" && isSelected ? "应用中..." : "应用"}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={profileBusy}
                    title={
                      isActive
                        ? "保存当前草稿到这个档案，并立即更新运行时。"
                        : "保存当前草稿到这个档案；不会切换当前运行时。"
                    }
                    onClick={() => {
                      onSelectedProfileChange(scope, profile.id);
                      void onUpdateProfile(scope, profile.id);
                    }}
                  >
                    {profileState === "updating" && isSelected ? busyUpdateLabel : updateLabel}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={profileBusy}
                    onClick={() => {
                      onSelectedProfileChange(scope, profile.id);
                      void onDuplicateProfile(scope, profile.id);
                    }}
                  >
                    {profileState === "duplicating" && isSelected ? "复制中..." : "复制"}
                  </button>
                  <button
                    className="ghost-button profile-danger-button"
                    type="button"
                    disabled={profileBusy}
                    onClick={() => {
                      onSelectedProfileChange(scope, profile.id);
                      void onDeleteProfile(scope, profile.id);
                    }}
                  >
                    {profileState === "deleting" && isSelected ? "删除中..." : "删除"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="profile-card-status" aria-live="polite">
        <span>
          当前 {scopeLabel} 运行时档案：
          <strong>{activeProfile?.name ?? "未绑定档案"}</strong>
        </span>
        <span>
          已保存：
          <strong>{profiles.length}</strong>
        </span>
        <span>{profileActionLabel(profileState)}</span>
      </div>

      {profileError && <p className="error-note">{profileError}</p>}
    </section>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
      <small>{hint}</small>
    </div>
  );
}

function RouteCredentialFields({
  title,
  badge,
  tone,
  baseUrlLabel,
  baseUrlHint,
  apiKeyLabel,
  apiKeyHint,
  baseUrl,
  apiKey,
  storedApiKey,
  clearApiKey,
  profileUrlSuggestions = [],
  onBaseUrlChange,
  onApiKeyChange,
  onToggleClearApiKey
}: {
  title: string;
  badge: string;
  tone: "primary" | "compact" | "claude";
  baseUrlLabel: string;
  baseUrlHint: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  baseUrl: string;
  apiKey: string;
  storedApiKey: boolean;
  clearApiKey: boolean;
  profileUrlSuggestions?: ProfileUrlSuggestion[];
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onToggleClearApiKey: () => void;
}) {
  const [urlSuggestionsOpen, setUrlSuggestionsOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const suggestionsId = useId();
  const visibleSuggestions = profileUrlSuggestions.slice(0, 8);
  const showSuggestions = urlSuggestionsOpen && visibleSuggestions.length > 0;
  const activeSuggestionId =
    showSuggestions && activeSuggestionIndex >= 0
      ? `${suggestionsId}-option-${activeSuggestionIndex}`
      : undefined;

  useEffect(() => {
    if (!showSuggestions) {
      setActiveSuggestionIndex(-1);
      return;
    }

    setActiveSuggestionIndex((previous) =>
      previous >= visibleSuggestions.length ? visibleSuggestions.length - 1 : previous
    );
  }, [showSuggestions, visibleSuggestions.length]);

  function selectSuggestion(suggestion: ProfileUrlSuggestion) {
    onBaseUrlChange(suggestion.baseUrl);
    setUrlSuggestionsOpen(false);
    setActiveSuggestionIndex(-1);
  }

  return (
    <section className={`route-config-card tone-${tone}`} aria-label={title}>
      <div className="route-config-card-head">
        <h4>{title}</h4>
        <span className={`route-chip ${tone}`}>{badge}</span>
      </div>

      <Field label={baseUrlLabel} hint={baseUrlHint}>
        <div className="route-url-input-wrap">
          <input
            aria-label={baseUrlLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-activedescendant={activeSuggestionId}
            aria-controls={showSuggestions ? suggestionsId : undefined}
            aria-expanded={showSuggestions}
            aria-haspopup="listbox"
            value={baseUrl}
            onFocus={() => setUrlSuggestionsOpen(true)}
            onBlur={() => {
              window.setTimeout(() => {
                setUrlSuggestionsOpen(false);
                setActiveSuggestionIndex(-1);
              }, 100);
            }}
            onChange={(event) => {
              setUrlSuggestionsOpen(true);
              setActiveSuggestionIndex(-1);
              onBaseUrlChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && urlSuggestionsOpen) {
                event.preventDefault();
                setUrlSuggestionsOpen(false);
                setActiveSuggestionIndex(-1);
                return;
              }

              if (visibleSuggestions.length === 0) {
                return;
              }

              if (event.key === "ArrowDown") {
                event.preventDefault();
                setUrlSuggestionsOpen(true);
                setActiveSuggestionIndex((previous) =>
                  previous < 0 ? 0 : (previous + 1) % visibleSuggestions.length
                );
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                setUrlSuggestionsOpen(true);
                setActiveSuggestionIndex((previous) =>
                  previous < 0
                    ? visibleSuggestions.length - 1
                    : (previous - 1 + visibleSuggestions.length) % visibleSuggestions.length
                );
                return;
              }

              if (event.key === "Enter" && showSuggestions && activeSuggestionIndex >= 0) {
                event.preventDefault();
                selectSuggestion(visibleSuggestions[activeSuggestionIndex]);
              }
            }}
            spellCheck={false}
          />
          {showSuggestions && (
            <div id={suggestionsId} className="route-url-suggestions" role="listbox">
              {visibleSuggestions.map((suggestion, index) => (
                <button
                  id={`${suggestionsId}-option-${index}`}
                  key={`${suggestion.baseUrl}:${suggestion.profileName}`}
                  type="button"
                  className="route-url-suggestion"
                  role="option"
                  aria-selected={index === activeSuggestionIndex}
                  data-active={index === activeSuggestionIndex || suggestion.baseUrl === baseUrl}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(suggestion)}
                >
                  <span className="route-url-suggestion-main">
                    <strong>{suggestion.host}</strong>
                    <small>{suggestion.baseUrl}</small>
                  </span>
                  <span className="route-url-suggestion-meta">
                    <span>{suggestion.profileName}</span>
                    <span>{formatClock(suggestion.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Field>

      <Field label={apiKeyLabel} hint={apiKeyHint}>
        <input
          aria-label={apiKeyLabel}
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={storedApiKey ? "输入新值以覆盖已保存密钥" : "sk-..."}
          onChange={(event) => onApiKeyChange(event.target.value)}
          spellCheck={false}
        />
        {(storedApiKey || clearApiKey) && (
          <div className="field-action-row">
            <button
              className={`field-inline-button ${clearApiKey ? "is-danger" : ""}`}
              type="button"
              onClick={onToggleClearApiKey}
            >
              {clearApiKey ? "取消清空" : "清空已保存密钥"}
            </button>
          </div>
        )}
      </Field>
    </section>
  );
}

function directApiKeyHint(
  routeLabelText: string,
  upstream?: PublicRouteCredentialConfig | null
): string {
  if (!upstream) {
    return "保存后会直接写入 compactgate.json。";
  }

  if (upstream.stored_api_key) {
    return "这个槽位已经保存过直填密钥。留空保持现状，输入新值后会直接覆盖。";
  }

  if (upstream.api_key_source === "env") {
    return `当前仍在回退环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。留空保持回退，输入新值后会改为直填密钥。`;
  }

  return `当前还没有 ${routeLabelText} 密钥；保存后会直接写入 compactgate.json。`;
}
