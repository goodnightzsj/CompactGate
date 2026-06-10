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
  setName: (name: string) => void;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setState: Dispatch<SetStateAction<ProfileActionState>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export interface ProfileNameSyncInput {
  profiles: Array<{ id: string; name: string }>;
  activeProfileId: string | null;
  selectedId: string;
  name: string;
  sourceProfileId: string | null;
  dirty: boolean;
}

export interface ProfileNameSyncResult {
  selectedId: string;
  name: string;
  sourceProfileId: string | null;
  dirty: boolean;
}

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
  const profileNameSyncRef = useRef({ sourceProfileId: null as string | null, dirty: false });
  const claudeProfileNameSyncRef = useRef({ sourceProfileId: null as string | null, dirty: false });

  useEffect(() => {
    if (!config) {
      return;
    }

    const scope = profileScopeState(config, "codex");
    const next = nextProfileNameSyncState({
      profiles: scope.profiles,
      activeProfileId: scope.active_profile_id,
      selectedId: selectedProfileId,
      name: profileName,
      sourceProfileId: profileNameSyncRef.current.sourceProfileId,
      dirty: profileNameSyncRef.current.dirty
    });
    profileNameSyncRef.current = {
      sourceProfileId: next.sourceProfileId,
      dirty: next.dirty
    };
    if (next.selectedId !== selectedProfileId) {
      setSelectedProfileId(next.selectedId);
    }
    if (next.name !== profileName) {
      setProfileName(next.name);
    }
  }, [config, profileName, selectedProfileId]);

  useEffect(() => {
    if (!config) {
      return;
    }

    const scope = profileScopeState(config, "claude");
    const next = nextProfileNameSyncState({
      profiles: scope.profiles,
      activeProfileId: scope.active_profile_id,
      selectedId: selectedClaudeProfileId,
      name: claudeProfileName,
      sourceProfileId: claudeProfileNameSyncRef.current.sourceProfileId,
      dirty: claudeProfileNameSyncRef.current.dirty
    });
    claudeProfileNameSyncRef.current = {
      sourceProfileId: next.sourceProfileId,
      dirty: next.dirty
    };
    if (next.selectedId !== selectedClaudeProfileId) {
      setSelectedClaudeProfileId(next.selectedId);
    }
    if (next.name !== claudeProfileName) {
      setClaudeProfileName(next.name);
    }
  }, [claudeProfileName, config, selectedClaudeProfileId]);

  function setProfileNameDraft(name: string): void {
    profileNameSyncRef.current.dirty = true;
    setProfileName(name);
  }

  function setClaudeProfileNameDraft(name: string): void {
    claudeProfileNameSyncRef.current.dirty = true;
    setClaudeProfileName(name);
  }

  function setSyncedProfileName(name: string): void {
    profileNameSyncRef.current = { sourceProfileId: null, dirty: false };
    setProfileName(name);
  }

  function setSyncedClaudeProfileName(name: string): void {
    claudeProfileNameSyncRef.current = { sourceProfileId: null, dirty: false };
    setClaudeProfileName(name);
  }

  function scopedProfileAccessors(scope: ConfigProfileScope): ScopedProfileAccessors {
    return scope === "codex"
      ? {
          name: profileName,
          selectedId: selectedProfileId,
          setName: setSyncedProfileName,
          setSelectedId: setSelectedProfileId,
          state: profileState,
          setState: setProfileState,
          setError: setProfileError
        }
      : {
          name: claudeProfileName,
          selectedId: selectedClaudeProfileId,
          setName: setSyncedClaudeProfileName,
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
    setClaudeProfileName: setClaudeProfileNameDraft,
    setProfileDeleteCandidate,
    setProfileName: setProfileNameDraft
  };
}

export function nextProfileNameSyncState(input: ProfileNameSyncInput): ProfileNameSyncResult {
  const selectedProfileExists = input.profiles.some((profile) => profile.id === input.selectedId);
  const selectedId = selectedProfileExists
    ? input.selectedId
    : input.activeProfileId ?? input.profiles[0]?.id ?? "";
  const selectedProfile = input.profiles.find((profile) => profile.id === selectedId) ?? null;

  if (!selectedProfile) {
    return {
      selectedId,
      name: input.dirty ? input.name : "",
      sourceProfileId: null,
      dirty: input.dirty
    };
  }

  if (input.dirty && input.sourceProfileId === selectedProfile.id) {
    return {
      selectedId,
      name: input.name,
      sourceProfileId: input.sourceProfileId,
      dirty: true
    };
  }

  return {
    selectedId,
    name: selectedProfile.name,
    sourceProfileId: selectedProfile.id,
    dirty: false
  };
}
