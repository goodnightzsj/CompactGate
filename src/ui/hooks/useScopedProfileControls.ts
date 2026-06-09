import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState
} from "react";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { profileScopeState } from "../config/profile-utils.js";
import type {
  ProfileActionState,
  ProfileDeleteCandidate
} from "../config/types.js";

export type ScopedProfileAccessors = {
  name: string;
  selectedId: string;
  state: ProfileActionState;
  setName: Dispatch<SetStateAction<string>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setState: Dispatch<SetStateAction<ProfileActionState>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useScopedProfileControls(config: PublicConfig | null) {
  const [profileName, setProfileName] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileState, setProfileState] = useState<ProfileActionState>("idle");
  const [claudeProfileName, setClaudeProfileName] = useState("");
  const [selectedClaudeProfileId, setSelectedClaudeProfileId] = useState("");
  const [claudeProfileState, setClaudeProfileState] = useState<ProfileActionState>("idle");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [claudeProfileError, setClaudeProfileError] = useState<string | null>(null);
  const [profileDeleteCandidate, setProfileDeleteCandidate] = useState<ProfileDeleteCandidate | null>(null);
  const profileNameHydratedRef = useRef(false);
  const claudeProfileNameHydratedRef = useRef(false);

  useEffect(() => {
    if (!config) {
      return;
    }

    const codexProfiles = profileScopeState(config, "codex").profiles;
    const claudeProfiles = profileScopeState(config, "claude").profiles;
    const activeCodexProfileId = profileScopeState(config, "codex").active_profile_id;
    const activeClaudeProfileId = profileScopeState(config, "claude").active_profile_id;

    setSelectedProfileId((previous) => {
      if (previous && codexProfiles.some((profile) => profile.id === previous)) {
        return previous;
      }

      return activeCodexProfileId ?? codexProfiles[0]?.id ?? "";
    });

    setSelectedClaudeProfileId((previous) => {
      if (previous && claudeProfiles.some((profile) => profile.id === previous)) {
        return previous;
      }

      return activeClaudeProfileId ?? claudeProfiles[0]?.id ?? "";
    });
  }, [config]);

  useEffect(() => {
    if (!config || profileNameHydratedRef.current) {
      return;
    }

    const scope = profileScopeState(config, "codex");
    const initialProfileId = scope.active_profile_id ?? scope.profiles[0]?.id ?? "";
    const initialProfile = scope.profiles.find((profile) => profile.id === initialProfileId);
    if (!initialProfile) {
      return;
    }

    profileNameHydratedRef.current = true;
    setSelectedProfileId(initialProfile.id);
    setProfileName(initialProfile.name);
  }, [config]);

  useEffect(() => {
    if (!config || claudeProfileNameHydratedRef.current) {
      return;
    }

    const scope = profileScopeState(config, "claude");
    const initialProfileId = scope.active_profile_id ?? scope.profiles[0]?.id ?? "";
    const initialProfile = scope.profiles.find((profile) => profile.id === initialProfileId);
    if (!initialProfile) {
      return;
    }

    claudeProfileNameHydratedRef.current = true;
    setSelectedClaudeProfileId(initialProfile.id);
    setClaudeProfileName(initialProfile.name);
  }, [config]);

  function scopedProfileAccessors(scope: ConfigProfileScope): ScopedProfileAccessors {
    return scope === "codex"
      ? {
          name: profileName,
          selectedId: selectedProfileId,
          setName: setProfileName,
          setSelectedId: setSelectedProfileId,
          state: profileState,
          setState: setProfileState,
          setError: setProfileError
        }
      : {
          name: claudeProfileName,
          selectedId: selectedClaudeProfileId,
          setName: setClaudeProfileName,
          setSelectedId: setSelectedClaudeProfileId,
          state: claudeProfileState,
          setState: setClaudeProfileState,
          setError: setClaudeProfileError
        };
  }

  return {
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
  };
}
