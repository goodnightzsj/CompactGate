import type { Dispatch, SetStateAction } from "react";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import {
  formAfterScopedProfileChange,
  formToProfilePatch
} from "../config/config-form-state.js";
import { profileScopeState } from "../config/profile-utils.js";
import type { ConfigFormState, SaveState } from "../config/types.js";
import { api, errorSummary } from "../shared/api.js";
import type { ScopedProfileAccessors } from "./useScopedProfileControls.js";

export function createConfigProfilePersistenceActions({
  config,
  form,
  formRevision,
  setConfig,
  applyProfileConfig,
  refreshHealthAfterWrite,
  setSaveError,
  setSaveState,
  scopedProfileAccessors
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  formRevision: string | null;
  setConfig: (config: PublicConfig, form?: SetStateAction<ConfigFormState>) => Promise<void>;
  applyProfileConfig: (config: PublicConfig, scope: ConfigProfileScope) => Promise<void>;
  refreshHealthAfterWrite: () => Promise<void>;
  setSaveError: Dispatch<SetStateAction<string | null>>;
  setSaveState: Dispatch<SetStateAction<SaveState>>;
  scopedProfileAccessors: (scope: ConfigProfileScope) => ScopedProfileAccessors;
}) {
  async function saveConfigProfile(
    scope: ConfigProfileScope = "codex",
    nameOverride?: string
  ): Promise<boolean> {
    const accessors = scopedProfileAccessors(scope);
    const submittedName = { name: accessors.name, selectedId: accessors.selectedId, selectionRevision: accessors.selectionRevision };
    const trimmedName = (nameOverride ?? accessors.name).trim();
    if (!trimmedName) {
      accessors.setState("error");
      accessors.setError("请先填写配置档案名称。");
      return false;
    }

    accessors.setState("saving");
    accessors.setError(null);

    try {
      if (!config || !formRevision) throw new Error("配置尚未加载，请重试加载后再保存档案。");
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "POST",
        body: JSON.stringify({
          scope,
          name: trimmedName,
          // Carries a form draft, so it needs the same lost-update guard as
          // PATCH /api/config. `applySelectedProfile` deliberately omits it:
          // it sends no draft, only a profile id.
          revision: formRevision,
          config: formToProfilePatch(form, scope)
        })
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const savedProfile = [...nextScope.profiles]
        .reverse()
        .find((profile) => profile.name === trimmedName);
      const savedProfileIsActive = Boolean(
        savedProfile?.id && savedProfile.id === nextScope.active_profile_id
      );

      // The write already landed on the server, so commit it before touching
      // anything that can fail. Letting a health-probe error fall to the catch
      // block used to leave the UI showing the pre-save profile while the file
      // on disk had already changed.
      // Rebuild only the saved scope; other draft fields never reached the server.
      await setConfig(nextConfig, savedProfileIsActive
        ? (current) => formAfterScopedProfileChange(current, nextConfig, scope, form) : undefined);
      if (savedProfileIsActive) {
        setSaveError(null);
        setSaveState("saved");
        window.setTimeout(
          () => setSaveState((current) => current === "saved" ? "idle" : current),
          1600
        );
      }
      accessors.commitSavedName(submittedName, savedProfile?.id ?? nextScope.active_profile_id ?? "", savedProfile?.name ?? trimmedName);
      accessors.setState("saved");
      window.setTimeout(
        () => accessors.setState((current) => current === "saved" ? "idle" : current),
        1600
      );
      if (savedProfileIsActive) await refreshHealthAfterWrite();
      return true;
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
      return false;
    }
  }

  async function applySelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string) {
    const accessors = scopedProfileAccessors(scope);
    const targetProfileId = profileId ?? accessors.selectedId;
    if (!targetProfileId) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return;
    }

    accessors.setState("applying");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles/apply", {
        method: "POST",
        body: JSON.stringify({
          scope,
          profile_id: targetProfileId
        })
      });
      await applyProfileConfig(nextConfig, scope);
      // The click already selected the target; keep later selection and rename edits.
      setSaveError(null);
      setSaveState("saved");
      accessors.setState("applied");
      // Each reset only clears the badge this call set, so a timer from an earlier
      // action cannot land mid-flight on the next one and drop its spinner.
      window.setTimeout(() => {
        setSaveState((current) => current === "saved" ? "idle" : current);
        accessors.setState((current) => current === "applied" ? "idle" : current);
      }, 1600);
      await refreshHealthAfterWrite();
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  async function updateSelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string): Promise<boolean> {
    const accessors = scopedProfileAccessors(scope);
    const submittedName = { name: accessors.name, selectedId: accessors.selectedId, selectionRevision: accessors.selectionRevision };
    const targetProfileId = profileId ?? accessors.selectedId;
    if (!targetProfileId) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return false;
    }

    const scopeState = config ? profileScopeState(config, scope) : null;
    const currentProfile = scopeState?.profiles.find((profile) => profile.id === targetProfileId) ?? null;
    const trimmedName = targetProfileId === accessors.selectedId ? accessors.name.trim() : currentProfile?.name ?? "";
    if (targetProfileId === accessors.selectedId && !trimmedName) {
      accessors.setState("error");
      accessors.setError("请先填写配置档案名称。");
      return false;
    }

    accessors.setState("updating");
    accessors.setError(null);

    try {
      if (!config || !formRevision) throw new Error("配置尚未加载，请重试加载后再保存档案。");
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "PATCH",
        body: JSON.stringify({
          scope,
          profile_id: targetProfileId,
          revision: formRevision,
          ...(trimmedName ? { name: trimmedName } : {}),
          config: formToProfilePatch(form, scope)
        })
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const profileIsActive = targetProfileId === nextScope.active_profile_id;

      await setConfig(nextConfig, profileIsActive
        ? (current) => formAfterScopedProfileChange(current, nextConfig, scope, form) : undefined);
      if (profileIsActive) {
        setSaveError(null);
        setSaveState("saved");
        window.setTimeout(
          () => setSaveState((current) => current === "saved" ? "idle" : current),
          1600
        );
      }
      accessors.commitSavedName(submittedName, targetProfileId,
        nextScope.profiles.find((profile) => profile.id === targetProfileId)?.name ?? trimmedName);
      accessors.setState("updated");
      window.setTimeout(
        () => accessors.setState((current) => current === "updated" ? "idle" : current),
        1600
      );
      if (profileIsActive) await refreshHealthAfterWrite();
      return true;
    } catch (error) {
      const message = errorSummary(error);
      accessors.setState("error");
      accessors.setError(/superseded revision/i.test(message)
        ? "配置已更新，档案未写入。请核对最新档案后重新确认保存。"
        : message);
      return false;
    }
  }

  return {
    applySelectedProfile,
    saveConfigProfile,
    updateSelectedProfile
  };
}
