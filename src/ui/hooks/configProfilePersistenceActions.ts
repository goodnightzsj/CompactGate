import type { Dispatch, SetStateAction } from "react";
import type { ConfigProfileScope, HealthResponse, PublicConfig } from "../../shared/types.js";
import {
  formAfterScopedProfileChange,
  formToPatch
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
  setForm,
  setHealth,
  setSaveError,
  setSaveState,
  scopedProfileAccessors
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  formRevision: string | null;
  setConfig: Dispatch<SetStateAction<PublicConfig | null>>;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
  setHealth: Dispatch<SetStateAction<HealthResponse | null>>;
  setSaveError: Dispatch<SetStateAction<string | null>>;
  setSaveState: Dispatch<SetStateAction<SaveState>>;
  scopedProfileAccessors: (scope: ConfigProfileScope) => ScopedProfileAccessors;
}) {
  async function saveConfigProfile(
    scope: ConfigProfileScope = "codex",
    nameOverride?: string
  ): Promise<boolean> {
    const accessors = scopedProfileAccessors(scope);
    const trimmedName = (nameOverride ?? accessors.name).trim();
    if (!trimmedName) {
      accessors.setState("error");
      accessors.setError("请先填写配置档案名称。");
      return false;
    }

    accessors.setState("saving");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "POST",
        body: JSON.stringify({
          scope,
          name: trimmedName,
          // Carries a form draft, so it needs the same lost-update guard as
          // PATCH /api/config. `applySelectedProfile` deliberately omits it:
          // it sends no draft, only a profile id.
          revision: formRevision,
          config: formToPatch(form)
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
      setConfig(nextConfig);
      if (savedProfileIsActive) {
        const nextHealth = await fetchHealthOrNull();
        if (nextHealth) {
          setHealth(nextHealth);
        }
        // Only the saved scope round-tripped through the server; rebuilding the
        // whole form here would revert untouched draft fields.
        setForm((current) => formAfterScopedProfileChange(current, nextConfig, scope));
        setSaveError(null);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1600);
      }
      accessors.setSelectedId(savedProfile?.id ?? nextScope.active_profile_id ?? "");
      accessors.setName(savedProfile?.name ?? trimmedName);
      accessors.setState("saved");
      window.setTimeout(() => accessors.setState("idle"), 1600);
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
      const nextHealth = await fetchHealthOrNull();
      const nextScope = profileScopeState(nextConfig, scope);
      const nextActiveProfileId = nextScope.active_profile_id ?? targetProfileId;

      setConfig(nextConfig);
      if (nextHealth) {
        setHealth(nextHealth);
      }
      setForm((current) => formAfterScopedProfileChange(current, nextConfig, scope));
      accessors.setSelectedId(nextActiveProfileId);
      // Applying a profile stores no name, so it must not reset the rename draft:
      // the sync effect fills the field from the selected profile whenever the
      // operator is not mid-edit.
      setSaveError(null);
      setSaveState("saved");
      accessors.setState("applied");
      window.setTimeout(() => {
        setSaveState("idle");
        accessors.setState("idle");
      }, 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  async function updateSelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string) {
    const accessors = scopedProfileAccessors(scope);
    const targetProfileId = profileId ?? accessors.selectedId;
    if (!targetProfileId) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return;
    }

    const scopeState = config ? profileScopeState(config, scope) : null;
    const currentProfile = scopeState?.profiles.find((profile) => profile.id === targetProfileId) ?? null;
    const trimmedName = targetProfileId === accessors.selectedId ? accessors.name.trim() : currentProfile?.name ?? "";
    if (targetProfileId === accessors.selectedId && !trimmedName) {
      accessors.setState("error");
      accessors.setError("请先填写配置档案名称。");
      return;
    }

    accessors.setState("updating");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "PATCH",
        body: JSON.stringify({
          scope,
          profile_id: targetProfileId,
          revision: formRevision,
          ...(trimmedName ? { name: trimmedName } : {}),
          config: formToPatch(form)
        })
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const profileIsActive = targetProfileId === nextScope.active_profile_id;

      setConfig(nextConfig);
      if (profileIsActive) {
        const nextHealth = await fetchHealthOrNull();
        if (nextHealth) {
          setHealth(nextHealth);
        }
        setForm((current) => formAfterScopedProfileChange(current, nextConfig, scope));
        setSaveError(null);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1600);
      }
      accessors.setSelectedId(targetProfileId);
      accessors.setName(nextScope.profiles.find((profile) => profile.id === targetProfileId)?.name ?? trimmedName);
      accessors.setState("updated");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  return {
    applySelectedProfile,
    saveConfigProfile,
    updateSelectedProfile
  };
}

/**
 * The health probe is a read-only follow-up to a write that already succeeded.
 * Letting it reject would abandon the config the server just returned, so the
 * UI would keep rendering the pre-write state.
 */
async function fetchHealthOrNull(): Promise<HealthResponse | null> {
  try {
    return await api<HealthResponse>("/api/health", { method: "GET" });
  } catch {
    return null;
  }
}
