import {
  type Dispatch,
  type SetStateAction,
  useState
} from "react";
import type {
  PublicConfig
} from "../../shared/types.js";
import { ConfigPage } from "../config/ConfigPage.js";
import type {
  ConfigFormState,
  ConfigTab
} from "../config/types.js";
import type { ConfigActions } from "../hooks/useConfigActions.js";

export type ConfigWorkspaceProps = {
  actions: ConfigActions;
  config: PublicConfig | null;
  form: ConfigFormState;
  hasPendingChanges: boolean;
  linkedCompactModel: string;
  onFormChange: Dispatch<SetStateAction<ConfigFormState>>;
};

export function ConfigWorkspace({
  actions,
  config,
  form,
  hasPendingChanges,
  linkedCompactModel,
  onFormChange
}: ConfigWorkspaceProps) {
  const [configTab, setConfigTab] = useState<ConfigTab>("profiles");

  return (
    <ConfigPage
      config={config}
      form={form}
      onFormChange={onFormChange}
      model={{
        linkedCompactModel,
        onUnlockCompactModel: actions.unlockCompactModel,
        onRestoreLinkedMode: actions.restoreLinkedMode
      }}
      save={{
        saveState: actions.saveState,
        saveError: actions.saveError,
        hasPendingChanges,
        onSaveConfig: actions.saveConfig
      }}
      profiles={{
        profileName: actions.profileName,
        selectedProfileId: actions.selectedProfileId,
        profileState: actions.profileState,
        profileError: actions.profileError,
        claudeProfileName: actions.claudeProfileName,
        selectedClaudeProfileId: actions.selectedClaudeProfileId,
        claudeProfileState: actions.claudeProfileState,
        claudeProfileError: actions.claudeProfileError,
        onProfileNameChange: actions.setProfileName,
        onClaudeProfileNameChange: actions.setClaudeProfileName,
        onSelectedProfileChange: actions.selectConfigProfile,
        onSaveProfile: actions.saveConfigProfile,
        onApplyProfile: actions.applySelectedProfile,
        onUpdateProfile: actions.updateSelectedProfile,
        onReorderProfiles: actions.reorderProfiles,
        onDuplicateProfile: actions.duplicateSelectedProfile,
        onDeleteProfile: actions.requestDeleteSelectedProfile
      }}
      previewState={{
        previewPath: actions.previewPath,
        previewBody: actions.previewBody,
        preview: actions.preview,
        previewError: actions.previewError,
        onPathChange: actions.setPreviewPath,
        onBodyChange: actions.setPreviewBody,
        onPreviewSubmit: actions.previewRoute
      }}
      tab={{
        configTab,
        onConfigTabChange: setConfigTab
      }}
      portable={{
        onExportConfig: actions.exportConfig,
        onImportConfig: actions.importConfig
      }}
    />
  );
}
