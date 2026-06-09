import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { profileScopeState } from "../config/profile-utils.js";
import { api, errorSummary } from "../shared/api.js";
import type { ConfigProfileCollectionActionContext } from "./configProfileActionContext.js";

export function createConfigProfileCollectionActions({
  config,
  profileDeleteCandidate,
  setConfig,
  setProfileDeleteCandidate,
  scopedProfileAccessors
}: ConfigProfileCollectionActionContext) {
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

    const copyName = nextDuplicateProfileName({
      profiles: scopeState?.profiles ?? [],
      selectedName: targetProfileId === accessors.selectedId ? accessors.name : "",
      sourceName: sourceProfile.name
    });
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
    confirmDeleteSelectedProfile,
    duplicateSelectedProfile,
    reorderProfiles,
    requestDeleteSelectedProfile,
    selectConfigProfile
  };
}

export function nextDuplicateProfileName({
  profiles,
  selectedName,
  sourceName
}: {
  profiles: PublicConfig["profiles"];
  selectedName: string;
  sourceName: string;
}): string {
  const trimmedSourceName = sourceName.trim();
  const trimmedSelectedName = selectedName.trim();
  if (trimmedSelectedName && trimmedSelectedName !== trimmedSourceName) {
    return trimmedSelectedName;
  }

  const existingNames = new Set(profiles.map((profile) => profile.name));
  const baseName = `${trimmedSourceName || "Profile"} copy`;
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
}
