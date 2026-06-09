import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { ProfileScopeCard } from "./ProfileScopeCard.js";
import type { ProfileActionState } from "./types.js";

export function ConfigProfilesPanel({
  config,
  profileName,
  selectedProfileId,
  profileState,
  profileError,
  claudeProfileName,
  selectedClaudeProfileId,
  claudeProfileState,
  claudeProfileError,
  onProfileNameChange,
  onClaudeProfileNameChange,
  onSelectedProfileChange,
  onSaveProfile,
  onApplyProfile,
  onUpdateProfile,
  onReorderProfiles,
  onDuplicateProfile,
  onDeleteProfile
}: {
  config: PublicConfig | null;
  profileName: string;
  selectedProfileId: string;
  profileState: ProfileActionState;
  profileError: string | null;
  claudeProfileName: string;
  selectedClaudeProfileId: string;
  claudeProfileState: ProfileActionState;
  claudeProfileError: string | null;
  onProfileNameChange: (name: string) => void;
  onClaudeProfileNameChange: (name: string) => void;
  onSelectedProfileChange: (scope: ConfigProfileScope, profileId: string) => void;
  onSaveProfile: (scope: ConfigProfileScope) => void | Promise<void>;
  onApplyProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUpdateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onReorderProfiles: (scope: ConfigProfileScope, profileIds: string[]) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
}) {
  return (
    <div className="profile-scope-grid">
      <ProfileScopeCard
        scope="codex"
        title="Codex 配置档案"
        eyebrow="Codex"
        description="保存、复制或应用 Codex 主路由与 compact 草稿，不会改动 Claude 档案。"
        emptyTitle="还没有保存的 Codex 档案"
        emptyDescription="填写名称后保存当前 Codex 草稿，就会在这里出现可应用的档案卡片。"
        config={config}
        profileName={profileName}
        selectedProfileId={selectedProfileId}
        profileState={profileState}
        profileError={profileError}
        onProfileNameChange={onProfileNameChange}
        onSelectedProfileChange={onSelectedProfileChange}
        onSaveProfile={onSaveProfile}
        onApplyProfile={onApplyProfile}
        onUpdateProfile={onUpdateProfile}
        onReorderProfiles={onReorderProfiles}
        onDuplicateProfile={onDuplicateProfile}
        onDeleteProfile={onDeleteProfile}
      />
      <ProfileScopeCard
        scope="claude"
        title="Claude 配置档案"
        eyebrow="Claude"
        description="保存、复制或应用 Claude 主路由与模型映射草稿，不会改动 Codex 档案。"
        emptyTitle="还没有保存的 Claude 档案"
        emptyDescription="填写名称后保存当前 Claude 草稿，就会在这里出现可应用的档案卡片。"
        config={config}
        profileName={claudeProfileName}
        selectedProfileId={selectedClaudeProfileId}
        profileState={claudeProfileState}
        profileError={claudeProfileError}
        onProfileNameChange={onClaudeProfileNameChange}
        onSelectedProfileChange={onSelectedProfileChange}
        onSaveProfile={onSaveProfile}
        onApplyProfile={onApplyProfile}
        onUpdateProfile={onUpdateProfile}
        onReorderProfiles={onReorderProfiles}
        onDuplicateProfile={onDuplicateProfile}
        onDeleteProfile={onDeleteProfile}
      />
    </div>
  );
}
