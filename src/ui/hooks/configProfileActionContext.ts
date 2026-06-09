import type { Dispatch, SetStateAction } from "react";
import type { ConfigProfileScope, HealthResponse, PublicConfig } from "../../shared/types.js";
import type {
  ConfigFormState,
  ProfileDeleteCandidate,
  SaveState
} from "../config/types.js";
import type { ScopedProfileAccessors } from "./useScopedProfileControls.js";

interface ConfigProfileAccessContext {
  config: PublicConfig | null;
  setConfig: Dispatch<SetStateAction<PublicConfig | null>>;
  scopedProfileAccessors: (scope: ConfigProfileScope) => ScopedProfileAccessors;
}

export interface ConfigProfilePersistenceActionContext extends ConfigProfileAccessContext {
  form: ConfigFormState;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
  setHealth: Dispatch<SetStateAction<HealthResponse | null>>;
  setSaveError: Dispatch<SetStateAction<string | null>>;
  setSaveState: Dispatch<SetStateAction<SaveState>>;
}

export interface ConfigProfileCollectionActionContext extends ConfigProfileAccessContext {
  profileDeleteCandidate: ProfileDeleteCandidate | null;
  setProfileDeleteCandidate: Dispatch<SetStateAction<ProfileDeleteCandidate | null>>;
}
