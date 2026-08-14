import { useEffect, useRef, useState } from "react";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { formatClock } from "../shared/format.js";
import { ConfirmProfileOverwriteDialog } from "./ConfirmProfileOverwriteDialog.js";
import { Field } from "./Field.js";
import {
  isProfileActionBusy,
  nextUniqueProfileName,
  profileActionLabel,
  profileScopeState,
  profileSummary
} from "./profile-utils.js";
import type { ProfileActionState, ProfileOverwriteCandidate } from "./types.js";
import { useProfileDragReorder } from "./useProfileDragReorder.js";

export function ProfileScopeCard({
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
  onCopyProfileRoutes,
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
  onSaveProfile: (scope: ConfigProfileScope, name?: string) => void | Promise<boolean>;
  onApplyProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUpdateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onReorderProfiles: (scope: ConfigProfileScope, profileIds: string[]) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onCopyProfileRoutes: (profile: PublicConfig["profiles"][number]) => void;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
}) {
  const titleId = `${scope}-profile-card-title`;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [createMode, setCreateMode] = useState(false);
  const [overwriteCandidate, setOverwriteCandidate] = useState<ProfileOverwriteCandidate | null>(null);
  useEffect(() => {
    setCreateMode(false);
  }, [selectedProfileId]);
  const scopeState = config ? profileScopeState(config, scope) : { profiles: [], active_profile_id: null };
  const profiles = scopeState.profiles;
  const activeProfile = profiles.find((profile) => profile.id === scopeState.active_profile_id) ?? null;
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const scopeLabel = scope === "codex" ? "Codex" : "Claude";
  const destinationScopeLabel = scope === "codex" ? "Claude" : "Codex";
  const namedProfile = profiles.find((profile) => profile.name === profileName.trim()) ?? null;
  const saveWillApply = Boolean(namedProfile && namedProfile.id === activeProfile?.id);
  const saveTargetsSelected = Boolean(
    namedProfile && (namedProfile.id === selectedProfile?.id || namedProfile.id === activeProfile?.id)
  );
  const saveButtonText = profileState === "saving"
    ? saveWillApply ? "正在保存并应用..." : "正在保存档案..."
    : createMode
      ? `保存当前 ${scopeLabel} 草稿为新档案`
      : saveWillApply
        ? `保存并应用当前 ${scopeLabel} 草稿`
        : saveTargetsSelected
          ? `保存到档案「${namedProfile?.name ?? ""}」`
          : namedProfile
            ? `覆盖档案「${namedProfile.name}」`
            : `保存当前 ${scopeLabel} 草稿为新档案`;
  const profileNameHint = createMode
    ? "正在新建档案，输入新名称后保存；不会自动切换当前运行时。"
    : saveWillApply
      ? "名称命中当前运行时档案，保存后会立即应用到运行时。"
      : saveTargetsSelected
        ? "名称命中当前选中的档案，保存后只覆盖该档案，不切换当前运行时。"
        : namedProfile
          ? "名称命中其他未选中的档案，保存会覆盖它——点击保存前会先确认。"
          : "填写新名称会创建新档案，不会自动切换当前运行时。";
  const profileBusy = isProfileActionBusy(profileState);

  function handleToggleCreateMode() {
    if (createMode) {
      setCreateMode(false);
      onProfileNameChange(selectedProfile?.name ?? "");
      return;
    }

    setCreateMode(true);
    onProfileNameChange("");
    nameInputRef.current?.focus();
  }

  async function handleSaveClick() {
    const trimmedName = profileName.trim();
    const named = trimmedName
      ? profiles.find((profile) => profile.name === trimmedName) ?? null
      : null;
    if (named && (createMode || (named.id !== selectedProfileId && named.id !== activeProfile?.id))) {
      setOverwriteCandidate({
        scope,
        profile: named,
        suggestedName: nextUniqueProfileName(trimmedName, profiles.map((profile) => profile.name))
      });
      return;
    }

    const ok = await onSaveProfile(scope);
    if (ok !== false && createMode) {
      setCreateMode(false);
    }
  }

  async function handleOverwriteConfirm(): Promise<boolean> {
    const ok = await onSaveProfile(scope);
    if (ok !== false) {
      setOverwriteCandidate(null);
      setCreateMode(false);
      return true;
    }
    return false;
  }

  async function handleSaveAsNewConfirm(name: string): Promise<boolean> {
    const ok = await onSaveProfile(scope, name);
    if (ok !== false) {
      setOverwriteCandidate(null);
      setCreateMode(false);
      return true;
    }
    return false;
  }
  const canReorderProfiles = profiles.length > 1 && !profileBusy;
  const {
    draggedProfileId,
    dropTarget,
    handleProfileDragLeave,
    handleProfileDragOver,
    handleProfileDragStart,
    handleProfileDrop,
    handleProfileListDragLeave,
    handleProfileListDragOver,
    profileListRef,
    resetDragState
  } = useProfileDragReorder({
    canReorderProfiles,
    onReorderProfiles: (profileIds) => onReorderProfiles(scope, profileIds),
    profiles
  });

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
            ref={nameInputRef}
            aria-label={`${scopeLabel} 档案名称`}
            value={profileName}
            onChange={(event) => onProfileNameChange(event.target.value)}
            placeholder="选择档案后可在这里改名"
          />
        </Field>

        <div className="profile-control-row">
          <button
            className="ghost-button profile-save-button"
            type="button"
            disabled={profileBusy}
            title={
              createMode
                ? "创建新档案；不会自动切换当前运行时。"
                : saveWillApply
                  ? "保存当前草稿到当前运行时档案，并立即更新运行时。"
                  : saveTargetsSelected
                    ? "保存当前草稿到选中的档案；不会切换当前运行时。"
                    : namedProfile
                      ? "名字命中其他未选中的档案，保存前会先确认是否覆盖。"
                      : "创建新档案；不会自动切换当前运行时。"
            }
            onClick={() => void handleSaveClick()}
          >
            {saveButtonText}
          </button>
          <button
            className="ghost-button profile-new-button"
            type="button"
            disabled={profileBusy}
            title={createMode ? "退出新建，回到当前选中的档案。" : "清空名称并开始创建新档案。"}
            onClick={handleToggleCreateMode}
          >
            {createMode ? "取消新建" : "+ 新建档案"}
          </button>
        </div>
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
                  <details className="profile-item-more">
                    <summary title={`更多 ${profile.name} 档案操作`}>更多</summary>
                    <div className="profile-secondary-actions">
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
                        title={`仅复制 URL、协议和压缩模式到 ${destinationScopeLabel} 草稿；密钥保持不变。`}
                        onClick={() => onCopyProfileRoutes(profile)}
                      >
                        复制路由到 {destinationScopeLabel} 草稿
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
                        {profileState === "duplicating" && isSelected ? "复制中..." : "复制档案"}
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
                  </details>
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

      {overwriteCandidate && (
        <ConfirmProfileOverwriteDialog
          scope={overwriteCandidate.scope}
          profile={overwriteCandidate.profile}
          suggestedName={overwriteCandidate.suggestedName}
          existingNames={profiles.map((profile) => profile.name)}
          onCancel={() => setOverwriteCandidate(null)}
          onOverwrite={() => handleOverwriteConfirm()}
          onSaveAsNew={(name) => handleSaveAsNewConfirm(name)}
        />
      )}
    </section>
  );
}
