import { type Dispatch, type SetStateAction } from "react";
import type { HealthResponse, PublicConfig } from "../../shared/types.js";
import type { ConfigFormState, SaveState } from "../config/types.js";
import { createConfigProfileCollectionActions } from "./configProfileCollectionActions.js";
import { createConfigProfilePersistenceActions } from "./configProfilePersistenceActions.js";
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

  const persistenceActions = createConfigProfilePersistenceActions({
    config,
    form,
    setConfig,
    setForm,
    setHealth,
    setSaveError,
    setSaveState,
    scopedProfileAccessors
  });
  const collectionActions = createConfigProfileCollectionActions({
    config,
    profileDeleteCandidate,
    setConfig,
    setProfileDeleteCandidate,
    scopedProfileAccessors
  });

  return {
    ...persistenceActions,
    claudeProfileError,
    claudeProfileName,
    claudeProfileState,
    ...collectionActions,
    profileDeleteCandidate,
    profileError,
    profileName,
    profileState,
    selectedClaudeProfileId,
    selectedProfileId,
    setClaudeProfileName,
    setProfileDeleteCandidate,
    setProfileName
  };
}
