import { type Dispatch, type SetStateAction } from "react";
import type { ConfigProfileScope, HealthResponse, PublicConfig } from "../../shared/types.js";
import {
  formFromConfig,
  formToPatch
} from "../config/config-form-state.js";
import { profileScopeState } from "../config/profile-utils.js";
import type { ConfigFormState, SaveState } from "../config/types.js";
import { api, errorSummary } from "../shared/api.js";
import { useScopedProfileControls } from "./useScopedProfileControls.js";

export function useConfigProfileActions({
  config,
  form,
  setConfig,
  setForm,
  setHealth,
  setSaveError,
  setSaveState
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  setConfig: Dispatch<SetStateAction<PublicConfig | null>>;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
  setHealth: Dispatch<SetStateAction<HealthResponse | null>>;
  setSaveError: Dispatch<SetStateAction<string | null>>;
  setSaveState: Dispatch<SetStateAction<SaveState>>;
}) {
  const {
    claudeProfileError,
    claudeProfileName,
    claudeProfileState,
    profileDeleteCandidate,
    profileError,
    profileName,
    profileState,
    scopedProfileAccessors,
    selectedClaudeProfileId,
    selectedProfileId,
    setClaudeProfileName,
    setProfileDeleteCandidate,
    setProfileName
  } = useScopedProfileControls(config);

  async function saveConfigProfile(scope: ConfigProfileScope = "codex") {
    const accessors = scopedProfileAccessors(scope);
    const trimmedName = accessors.name.trim();
    if (!trimmedName) {
      accessors.setState("error");
      accessors.setError("请先填写配置档案名称。");
      return;
    }

    accessors.setState("saving");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "POST",
        body: JSON.stringify({
          scope,
          name: trimmedName,
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
      const nextHealth = savedProfileIsActive
        ? await api<HealthResponse>("/api/health", { method: "GET" })
        : null;

      setConfig(nextConfig);
      if (nextHealth) {
        setHealth(nextHealth);
        setForm(formFromConfig(nextConfig));
        setSaveError(null);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1600);
      }
      accessors.setSelectedId(savedProfile?.id ?? nextScope.active_profile_id ?? "");
      accessors.setName(savedProfile?.name ?? trimmedName);
      accessors.setState("saved");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
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
      const nextHealth = await api<HealthResponse>("/api/health", {
        method: "GET"
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const nextActiveProfileId = nextScope.active_profile_id ?? targetProfileId;

      setConfig(nextConfig);
      setHealth(nextHealth);
      setForm(formFromConfig(nextConfig));
      accessors.setSelectedId(nextActiveProfileId);
      accessors.setName(nextScope.profiles.find((profile) => profile.id === nextActiveProfileId)?.name ?? "");
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
    accessors.setState("updating");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "PATCH",
        body: JSON.stringify({
          scope,
          profile_id: targetProfileId,
          ...(trimmedName ? { name: trimmedName } : {}),
          config: formToPatch(form)
        })
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const profileIsActive = targetProfileId === nextScope.active_profile_id;
      const nextHealth = profileIsActive
        ? await api<HealthResponse>("/api/health", { method: "GET" })
        : null;

      setConfig(nextConfig);
      if (nextHealth) {
        setHealth(nextHealth);
        setForm(formFromConfig(nextConfig));
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

  async function reorderProfiles(scope: ConfigProfileScope, profileIds: string[]) {
    const accessors = scopedProfileAccessors(scope);
    if (!config) {
      accessors.setState("error");
      accessors.setError("配置还没有加载完成。");
      return;
    }

    const currentIds = profileScopeState(config, scope).profiles.map((profile) => profile.id);
    if (
      profileIds.length !== currentIds.length ||
      profileIds.some((profileId) => !currentIds.includes(profileId)) ||
      new Set(profileIds).size !== profileIds.length
    ) {
      accessors.setState("error");
      accessors.setError("档案排序列表和当前配置不一致，请刷新后重试。");
      return;
    }

    if (profileIds.every((profileId, index) => profileId === currentIds[index])) {
      return;
    }

    accessors.setState("reordering");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles/reorder", {
        method: "POST",
        body: JSON.stringify({
          scope,
          profile_ids: profileIds
        })
      });

      setConfig(nextConfig);
      const nextScope = profileScopeState(nextConfig, scope);
      const nextSelectedProfileId = accessors.selectedId && nextScope.profiles.some((profile) => profile.id === accessors.selectedId)
        ? accessors.selectedId
        : nextScope.active_profile_id ?? nextScope.profiles[0]?.id ?? "";
      accessors.setSelectedId(nextSelectedProfileId);
      accessors.setName(nextScope.profiles.find((profile) => profile.id === nextSelectedProfileId)?.name ?? "");
      accessors.setState("reordered");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  async function duplicateSelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string) {
    const accessors = scopedProfileAccessors(scope);
    const targetProfileId = profileId ?? accessors.selectedId;
    const scopeState = config ? profileScopeState(config, scope) : null;
    const sourceProfile = scopeState?.profiles.find((profile) => profile.id === targetProfileId) ?? null;
    if (!sourceProfile) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return;
    }

    const copyName = targetProfileId === accessors.selectedId && accessors.name.trim()
      ? accessors.name.trim()
      : `${sourceProfile.name} copy`;
    accessors.setState("duplicating");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles/duplicate", {
        method: "POST",
        body: JSON.stringify({
          scope,
          profile_id: targetProfileId,
          name: copyName
        })
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const copiedProfile = [...nextScope.profiles]
        .reverse()
        .find((profile) => profile.name === copyName);

      setConfig(nextConfig);
      accessors.setSelectedId(copiedProfile?.id ?? targetProfileId);
      accessors.setName(copiedProfile?.name ?? copyName);
      accessors.setState("duplicated");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  function requestDeleteSelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string) {
    const accessors = scopedProfileAccessors(scope);
    const targetProfileId = profileId ?? accessors.selectedId;
    if (!targetProfileId) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return;
    }

    const profile = config ? profileScopeState(config, scope).profiles.find((item) => item.id === targetProfileId) : null;
    if (!profile) {
      accessors.setState("error");
      accessors.setError("没有找到要删除的配置档案。");
      return;
    }

    accessors.setSelectedId(profile.id);
    accessors.setError(null);
    setProfileDeleteCandidate({ scope, profile });
  }

  async function confirmDeleteSelectedProfile() {
    const candidate = profileDeleteCandidate;
    if (!candidate) {
      return;
    }

    const accessors = scopedProfileAccessors(candidate.scope);
    accessors.setState("deleting");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "DELETE",
        body: JSON.stringify({
          scope: candidate.scope,
          profile_id: candidate.profile.id
        })
      });
      const nextScope = profileScopeState(nextConfig, candidate.scope);

      setConfig(nextConfig);
      const nextSelectedProfileId = nextScope.active_profile_id ?? nextScope.profiles[0]?.id ?? "";
      accessors.setSelectedId(nextSelectedProfileId);
      accessors.setName(nextScope.profiles.find((item) => item.id === nextSelectedProfileId)?.name ?? "");
      setProfileDeleteCandidate(null);
      accessors.setState("deleted");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  function selectConfigProfile(scope: ConfigProfileScope, profileId: string) {
    const accessors = scopedProfileAccessors(scope);
    const profile = config ? profileScopeState(config, scope).profiles.find((item) => item.id === profileId) : null;
    accessors.setSelectedId(profileId);
    accessors.setError(null);

    if (profile && profileId !== accessors.selectedId) {
      accessors.setName(profile.name);
    }
  }

  return {
    applySelectedProfile,
    claudeProfileError,
    claudeProfileName,
    claudeProfileState,
    confirmDeleteSelectedProfile,
    duplicateSelectedProfile,
    profileDeleteCandidate,
    profileError,
    profileName,
    profileState,
    reorderProfiles,
    requestDeleteSelectedProfile,
    saveConfigProfile,
    selectConfigProfile,
    selectedClaudeProfileId,
    selectedProfileId,
    setClaudeProfileName,
    setProfileDeleteCandidate,
    setProfileName,
    updateSelectedProfile
  };
}
