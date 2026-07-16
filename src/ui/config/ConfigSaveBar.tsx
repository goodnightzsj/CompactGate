import type * as React from "react";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { profileScopeState } from "./profile-utils.js";
import { saveButtonLabel, saveLabel } from "./save-state.js";
import type { SaveState } from "./types.js";

export function ConfigSaveBar({
  config,
  saveState,
  saveError,
  hasPendingChanges,
  onSaveConfig
}: {
  config: PublicConfig | null;
  saveState: SaveState;
  saveError: string | null;
  hasPendingChanges: boolean;
  onSaveConfig: (event: React.FormEvent) => void;
}) {
  const applyTarget = activeProfileApplyTarget(config);

  return (
    <aside className={`config-save-bar ${hasPendingChanges ? "is-dirty" : ""}`} aria-label="配置保存">
      {saveError && <div className="error-banner config-save-error">{saveError}</div>}
      <div className="config-save-copy" aria-live="polite">
        <strong>{saveLabel(saveState, hasPendingChanges, config?.last_saved_at)}</strong>
        <span>{applyTarget.hint}</span>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={saveState === "saving" || !hasPendingChanges}
        onClick={onSaveConfig}
      >
        {saveButtonLabel(saveState, hasPendingChanges, applyTarget.savesActiveProfiles)}
      </button>
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
