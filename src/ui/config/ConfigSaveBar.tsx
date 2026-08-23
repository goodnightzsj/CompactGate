import { useState } from "react";
import type * as React from "react";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { ConfigSaveAsNewProfileDialog } from "./ConfigSaveAsNewProfileDialog.js";
import { profileScopeState } from "./profile-utils.js";
import { saveButtonLabel, saveLabel } from "./save-state.js";
import type { SaveState } from "./types.js";

export function ConfigSaveBar({
  config,
  saveState,
  saveError,
  saveConflict,
  hasPendingChanges,
  profileErrors,
  onSaveConfig,
  onOverrideSaveConflict,
  onSaveProfileAsNew
}: {
  config: PublicConfig | null;
  saveState: SaveState;
  saveError: string | null;
  /** The save was refused because someone else wrote since this draft was built. */
  saveConflict: boolean;
  hasPendingChanges: boolean;
  /** Passed to the dialog: this bar is on every config tab, its error was not. */
  profileErrors: Record<ConfigProfileScope, string | null>;
  onSaveConfig: (event: React.FormEvent) => void;
  onOverrideSaveConflict: (event: React.FormEvent) => void;
  onSaveProfileAsNew: (scope: ConfigProfileScope, name: string) => void | Promise<boolean>;
}) {
  const [asNewOpen, setAsNewOpen] = useState(false);
  const applyTarget = activeProfileApplyTarget(config);

  return (
    <aside className={`config-save-bar ${hasPendingChanges ? "is-dirty" : ""}`} aria-label="配置保存">
      {saveError && (
        <div className="error-banner config-save-error">
          <span>{saveError}</span>
          {saveConflict && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={saveState === "saving"}
              title="保留当前草稿，按服务端最新版本重新保存。对方的改动会被本次保存覆盖。"
              onClick={onOverrideSaveConflict}
            >
              仍然保存我的草稿
            </button>
          )}
        </div>
      )}
      <div className="config-save-copy" aria-live="polite">
        <strong>{saveLabel(saveState, hasPendingChanges, config?.last_saved_at)}</strong>
        <span>{applyTarget.hint}</span>
      </div>
      <div className="config-save-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={saveState === "saving" || !hasPendingChanges}
          onClick={onSaveConfig}
        >
          {saveButtonLabel(saveState, hasPendingChanges, applyTarget.savesActiveProfiles)}
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={saveState === "saving" || !config}
          title="把当前表单草稿保存为新的配置档案，不改动已有档案。"
          onClick={() => setAsNewOpen(true)}
        >
          另存为新档案
        </button>
      </div>
      {asNewOpen && (
        <ConfigSaveAsNewProfileDialog
          config={config}
          profileErrors={profileErrors}
          onCancel={() => setAsNewOpen(false)}
          onConfirm={async (scope, name) => {
            const ok = await onSaveProfileAsNew(scope, name);
            if (ok !== false) {
              setAsNewOpen(false);
              return true;
            }
            return false;
          }}
        />
      )}
    </aside>
  );
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
