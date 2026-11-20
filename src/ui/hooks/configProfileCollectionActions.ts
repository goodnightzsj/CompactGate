import type { Dispatch, SetStateAction } from "react";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { profileScopeState } from "../config/profile-utils.js";
import type { ProfileDeleteCandidate } from "../config/types.js";
import { api, errorSummary } from "../shared/api.js";
import type { ScopedProfileAccessors } from "./useScopedProfileControls.js";

export function createConfigProfileCollectionActions({
  config,
  profileDeleteCandidate,
  onConfigChange,
  setProfileDeleteCandidate,
  scopedProfileAccessors
}: {
  config: PublicConfig | null;
  profileDeleteCandidate: ProfileDeleteCandidate | null;
  onConfigChange: (config: PublicConfig) => Promise<void>;
  setProfileDeleteCandidate: Dispatch<SetStateAction<ProfileDeleteCandidate | null>>;
  scopedProfileAccessors: (scope: ConfigProfileScope) => ScopedProfileAccessors;
}) {
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
          profile_ids: profileIds,
          revision: config.revision
        })
      });

      await onConfigChange(nextConfig);
      // The live controls own selection and rename drafts throughout this reorder.
      accessors.setState("reordered");
      // Only clear the badge this call set. An unconditional reset belonging to an
      // earlier action would land mid-flight on the next one and drop its spinner.
      window.setTimeout(
        () => accessors.setState((current) => current === "reordered" ? "idle" : current),
        1600
      );
    } catch (error) {
      accessors.setState("error");
      const summary = errorSummary(error);
      accessors.setError(/superseded revision/i.test(summary)
        ? "配置已更新。请查看最新档案顺序后重新排序。"
        : summary);
    }
  }

  /**
   * `targetScope` copies into the other scope instead of alongside the source.
   * Both directions run through the same endpoint so the copy carries the source
   * profile's credential — the server holds the keys, and a draft built here
   * never could.
   */
  async function duplicateSelectedProfile(
    scope: ConfigProfileScope = "codex",
    profileId?: string,
    options: { targetScope?: ConfigProfileScope; name?: string } = {}
  ): Promise<boolean> {
    const targetScope = options.targetScope ?? scope;
    const sourceAccessors = scopedProfileAccessors(scope);
    const sourceState = config ? profileScopeState(config, scope) : null;
    const sourceProfileId = profileId ?? sourceAccessors.selectedId;
    const sourceProfile = sourceState?.profiles.find((profile) => profile.id === sourceProfileId) ?? null;
    // Progress and failure belong to the scope the copy lands in, which is the
    // panel the user is watching.
    const accessors = scopedProfileAccessors(targetScope);
    if (!sourceProfile) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return false;
    }

    if (targetScope === scope) selectConfigProfile(scope, sourceProfileId);
    const selectionAtStart = {
      selectedId: targetScope === scope ? sourceProfileId : accessors.selectedId,
      name: targetScope === scope && sourceProfileId !== sourceAccessors.selectedId
        ? sourceProfile.name : accessors.name,
      interactionRevision: accessors.interactionRevision
    };

    // Named after the source, so the in-progress rename it defers to is the source
    // panel's — the destination's name field is about a different profile.
    const copyName = options.name?.trim() || nextDuplicateProfileName({
      profiles: (targetScope === scope ? sourceState?.profiles : config
        ? profileScopeState(config, targetScope)?.profiles
        : null) ?? [],
      selectedName: sourceProfileId === sourceAccessors.selectedId ? sourceAccessors.name : "",
      sourceName: sourceProfile.name
    });
    accessors.setState("duplicating");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles/duplicate", {
        method: "POST",
        body: JSON.stringify({
          scope,
          profile_id: sourceProfileId,
          name: copyName,
          ...(targetScope === scope ? {} : { target_scope: targetScope })
        })
      });
      const nextScope = profileScopeState(nextConfig, targetScope);
      const copiedProfile = [...nextScope.profiles]
        .reverse()
        .find((profile) => profile.name === copyName);

      await onConfigChange(nextConfig);
      // The source id is only a sane fallback within its own scope; across scopes
      // it names nothing the destination panel can select, so hold its selection.
      const fallbackId = targetScope === scope ? sourceProfileId : accessors.selectedId;
      accessors.setSelectedId(copiedProfile?.id ?? fallbackId, selectionAtStart);
      accessors.setState("duplicated");
      window.setTimeout(
        () => accessors.setState((current) => current === "duplicated" ? "idle" : current),
        1600
      );
      return true;
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
      return false;
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
    if (!profile || !config) {
      accessors.setState("error");
      accessors.setError("没有找到要删除的配置档案。");
      return;
    }

    accessors.setSelectedId(profile.id);
    accessors.setError(null);
    setProfileDeleteCandidate({ scope, profile, revision: config.revision });
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
          profile_id: candidate.profile.id,
          revision: candidate.revision
        })
      });
      const nextScope = profileScopeState(nextConfig, candidate.scope);

      await onConfigChange(nextConfig);
      const nextSelectedProfileId = nextScope.active_profile_id ?? nextScope.profiles[0]?.id ?? "";
      accessors.setSelectedId(nextSelectedProfileId);
      accessors.setName(nextScope.profiles.find((item) => item.id === nextSelectedProfileId)?.name ?? "");
      setProfileDeleteCandidate(null);
      accessors.setState("deleted");
      window.setTimeout(
        () => accessors.setState((current) => current === "deleted" ? "idle" : current),
        1600
      );
    } catch (error) {
      const summary = errorSummary(error);
      accessors.setState("error");
      accessors.setError(/superseded revision/i.test(summary)
        ? "配置已更新，档案未删除。请取消，查看最新档案后重新确认删除。"
        : summary);
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
