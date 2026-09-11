import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type {
  ConfigProfileScope,
  PublicConfig
} from "../../shared/types.js";
import {
  ConfigImportExportPanel
} from "./ConfigImportExportPanel.js";
import { CONFIG_TABS } from "./config-tabs.js";
import { changedConfigAreas } from "./config-form-state.js";
import { ConfigModelPanel } from "./ConfigModelPanel.js";
import { ConfigProfilesPanel } from "./ConfigProfilesPanel.js";
import { OAuthProfilesPanel } from "./OAuthProfilesPanel.js";
import { ConfigSaveBar } from "./ConfigSaveBar.js";
import { ConfigSaveAsNewProfileDialog } from "./ConfigSaveAsNewProfileDialog.js";
import { LoggingStoragePanel } from "./LoggingStoragePanel.js";
import { RouteConfigPanel } from "./RouteConfigPanel.js";
import {
  compactModeLabel,
  nextUniqueProfileName,
  profileItemId,
  profileScopeState
} from "./profile-utils.js";
import type { ConfigFormState, ConfigTab } from "./types.js";
import type { ConfigActions } from "../hooks/useConfigActions.js";
import { useConfigImportWorkflow } from "./useConfigImportWorkflow.js";

type ConfigDisplayScope = ConfigProfileScope | "all";

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
  const [displayScope, setDisplayScope] = useState<ConfigDisplayScope>("codex");
  const [profileToLocate, setProfileToLocate] = useState<{ scope: ConfigProfileScope; id: string } | null>(null);
  const visibleScope = configTab === "profiles" || displayScope !== "all" ? displayScope : "codex";
  const importWorkflow = useConfigImportWorkflow({
    onImportConfig: actions.importConfig
  });
  // The profile card renders these on the profiles tab only, but the save bar's
  // dialogs are reachable from every tab.
  const profileErrors = {
    codex: actions.profileError,
    claude: actions.claudeProfileError
  };

  useEffect(() => {
    if (!profileToLocate) return;
    const target = document.getElementById(profileItemId(profileToLocate.scope, profileToLocate.id));
    // Locating a card must not select it: selection resets the profile-name draft.
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", behavior: "auto" });
    setProfileToLocate(null);
  }, [profileToLocate]);

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">配置管理</p>
          <h2>配置管理</h2>
        </div>
      </div>

      <div className="config-layout">
        <div
          className="config-section"
          onFocusCapture={(event) => {
            const target = event.target;
            // Pointer focus must not scroll the button between pointerdown and
            // pointerup, otherwise the user's click lands on a different element.
            if (!(target instanceof HTMLElement) || !target.matches("input, select, textarea, button, summary, [tabindex]") || !target.matches(":focus-visible")) {
              return;
            }
            const saveBar = document.querySelector<HTMLElement>(".config-save-bar");
            if (!saveBar || saveBar.contains(target)) return;
            const field = target.getBoundingClientRect();
            const bar = saveBar.getBoundingClientRect();
            if (field.bottom > bar.top - 12 && field.top < bar.bottom) {
              target.scrollIntoView({ block: "center", behavior: "auto" });
            }
          }}
        >
          <div className="tab-bar config-tab-bar" role="tablist" aria-label="配置分类">
            {/*
              Roving tabindex plus arrow keys: a tablist is one stop in the page's
              tab order, and the arrows move between the tabs inside it. Every tab
              being separately tabbable worked but made the keyboard user walk the
              whole bar to reach what follows it.
            */}
            {CONFIG_TABS.map((tabItem, index) => (
              <button
                type="button"
                role="tab"
                id={`config-tab-${tabItem.id}`}
                aria-controls={`config-panel-${tabItem.id}`}
                aria-selected={configTab === tabItem.id}
                tabIndex={configTab === tabItem.id ? 0 : -1}
                key={tabItem.id}
                className={`config-tab ${configTab === tabItem.id ? "is-active" : ""}`}
                onClick={() => onConfigTabChange(tabItem.id)}
                onKeyDown={(event) => {
                  const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
                  if (delta === 0) {
                    return;
                  }
                  event.preventDefault();
                  const next = CONFIG_TABS[(index + delta + CONFIG_TABS.length) % CONFIG_TABS.length];
                  onConfigTabChange(next.id);
                  document.getElementById(`config-tab-${next.id}`)?.focus();
                }}
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
              <OAuthProfilesPanel config={config} onConfigChange={actions.receiveOAuthConfig}
                onProfileLocate={(scope, id) => {
                  setDisplayScope(scope);
                  setProfileToLocate({ scope, id });
                }} />
            )}
          {configTab !== "logging" && configTab !== "portable" && (
            <div className="config-scope-heading">
              {configTab === "profiles" && <div>
                <h3>配置档案</h3>
                <p>按客户端管理；上方授权连接为全局共享。应用档案才会切换运行配置。</p>
              </div>}
              <div className="client-scope-switch" role="group" aria-label="配置展示客户端">
              {(configTab === "profiles"
                ? ([
                    ["all", "全部"],
                    ["codex", "Codex"],
                    ["claude", "Claude"]
                  ] as const)
                : ([
                    ["codex", "Codex"],
                    ["claude", "Claude"]
                  ] as const)
              ).map(([scope, label]) => (
                <button
                  key={scope}
                  type="button"
                  className={visibleScope === scope ? "is-active" : ""}
                  aria-pressed={visibleScope === scope}
                  onClick={() => setDisplayScope(scope)}
                >
                  {label}
                </button>
              ))}
              </div>
            </div>
          )}
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
                    targetScope: profile.scope === "codex" ? "claude" : "codex"
                  });
                }}
                onDeleteProfile={actions.requestDeleteSelectedProfile}
                displayScope={displayScope}
              />
            )}

            {configTab === "routes" && (
              <RouteConfigPanel
                config={config}
                form={form}
                onFormChange={onFormChange}
                onManageOAuth={() => onConfigTabChange("profiles")}
                scope={displayScope === "all" ? "codex" : displayScope}
              />
            )}

            {configTab === "model" && (
              <ConfigModelPanel
                config={config}
                form={form}
                linkedCompactModel={linkedCompactModel}
                onFormChange={onFormChange}
                onUnlockCompactModel={actions.unlockCompactModel}
                onRestoreLinkedMode={actions.restoreLinkedMode}
                scope={displayScope === "all" ? "codex" : displayScope}
              />
            )}

            {configTab === "logging" && (
              <LoggingStoragePanel form={form} onFormChange={onFormChange} />
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

        {configTab !== "portable" && (
          <ConfigSaveBar
            config={config}
            saveState={actions.saveState}
            saveError={actions.saveError}
            saveConflict={actions.saveConflict}
            hasPendingChanges={hasPendingChanges}
            changedAreas={config ? changedConfigAreas(config, form) : []}
            profileErrors={profileErrors}
            onSaveConfig={actions.saveConfig}
            onOverrideSaveConflict={actions.overrideSaveConflict}
            onSaveProfileAsNew={actions.saveConfigProfile}
          />
        )}
      </div>

      {crossScopeDraft && (
        <CrossScopeProfileDialog
          config={config}
          draft={crossScopeDraft}
          profileErrors={profileErrors}
          onCancel={() => setCrossScopeDraft(null)}
          onConfirm={async (scope, name) => {
            const ok = await actions.duplicateSelectedProfile(
              crossScopeDraft.sourceProfile.scope,
              crossScopeDraft.sourceProfile.id,
              { targetScope: scope, name }
            );
            if (ok) {
              setCrossScopeDraft(null);
            }
            return ok;
          }}
        />
      )}
    </>
  );
}

type CrossScopeProfileDraft = {
  sourceProfile: PublicConfig["profiles"][number];
  targetScope: ConfigProfileScope;
};

function CrossScopeProfileDialog({
  config,
  draft,
  profileErrors,
  onCancel,
  onConfirm
}: {
  config: PublicConfig | null;
  draft: CrossScopeProfileDraft;
  profileErrors: Record<ConfigProfileScope, string | null>;
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
      profileErrors={profileErrors}
      title={`创建为 ${targetLabel} 档案`}
      description={draft.sourceProfile.oauth_account_id || draft.sourceProfile.compact_oauth_account_id
        ? `将「${draft.sourceProfile.name}」的地址与凭据复制到 ${targetLabel}；OAuth 路由保留连接及厂商协议，模型采用目标端默认值。不会自动应用或覆盖已有档案。`
        : `将「${draft.sourceProfile.name}」的地址与凭据复制到 ${targetLabel}。上游协议、模型与环境变量改用 ${targetLabel} 默认值；不会自动应用，目标端现有档案保持不变。`}
      submitLabel={`创建 ${targetLabel} 档案`}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="config-preview-result cross-scope-profile-preview" aria-label="待创建档案路由预览">
        <div className="cross-scope-route">
          <span>主路由</span>
          <strong>{routes.primaryUrl || "未配置"}</strong>
          <small>沿用源凭据</small>
        </div>
        <div className="cross-scope-route">
          <span>压缩路由</span>
          <strong>{routes.compactUrl || "未配置"}</strong>
          <small>沿用源凭据 · {compactModeLabel(routes.compactMode)}</small>
        </div>
      </div>
    </ConfigSaveAsNewProfileDialog>
  );
}

/**
 * Read off the source profile, not a local draft: the server builds the copy, and
 * the only fields it carries across scopes are the URLs and the compact mode shown
 * here. Manual routes reset their protocol to the destination's default; OAuth
 * routes keep the provider-bound protocol with the account reference.
 */
function crossScopeRoutePreview(draft: CrossScopeProfileDraft) {
  const source = draft.sourceProfile;
  return source.scope === "codex"
    ? {
        primaryUrl: source.primary_base_url ?? "",
        compactUrl: source.compact_base_url ?? "",
        // A profile saved before the mode was stored reports null; the copy lands
        // on the destination default, which is what "复用主上游" describes.
        compactMode: source.compact_upstream_mode ?? "primary"
      }
    : {
        primaryUrl: source.claude_primary_base_url ?? "",
        compactUrl: source.claude_compact_base_url ?? "",
        compactMode: source.claude_compact_upstream_mode ?? "primary"
      };
}
