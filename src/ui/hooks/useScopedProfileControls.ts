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
  const codex = useScopedProfileState(config, "codex");
  const claude = useScopedProfileState(config, "claude");
  const [profileDeleteCandidate, setProfileDeleteCandidate] = useState<ProfileDeleteCandidate | null>(null);

  return {
    claudeProfileError: claude.error,
    claudeProfileName: claude.name,
    claudeProfileState: claude.state,
    profileDeleteCandidate,
    profileError: codex.error,
    profileName: codex.name,
    profileState: codex.state,
    scopedProfileAccessors: (scope: ConfigProfileScope): ScopedProfileAccessors =>
      scope === "codex" ? codex.accessors : claude.accessors,
    selectedClaudeProfileId: claude.selectedId,
    selectedProfileId: codex.selectedId,
    setClaudeProfileName: claude.setDraftName,
    setProfileDeleteCandidate,
    setProfileName: codex.setDraftName
  };
}

function useScopedProfileState(config: PublicConfig | null, scope: ConfigProfileScope) {
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [state, setState] = useState<ProfileActionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const syncRef = useRef({ sourceProfileId: null as string | null, dirty: false });

  useEffect(() => {
    if (!config) {
      return;
    }

    const scopeState = profileScopeState(config, scope);
    const next = nextProfileNameSyncState({
      profiles: scopeState.profiles,
      activeProfileId: scopeState.active_profile_id,
      selectedId,
      name,
      sourceProfileId: syncRef.current.sourceProfileId,
      dirty: syncRef.current.dirty
    });
    syncRef.current = {
      sourceProfileId: next.sourceProfileId,
      dirty: next.dirty
    };
    if (next.selectedId !== selectedId) {
      setSelectedId(next.selectedId);
    }
    if (next.name !== name) {
      setName(next.name);
    }
  }, [config, name, scope, selectedId]);

  return {
    error,
    name,
    selectedId,
    state,
    setDraftName(nextName: string): void {
      syncRef.current.dirty = true;
      setName(nextName);
    },
    accessors: {
      name,
      selectedId,
      state,
      setName(nextName: string): void {
        syncRef.current = { sourceProfileId: null, dirty: false };
        setName(nextName);
      },
      setSelectedId,
      setState,
      setError
    } satisfies ScopedProfileAccessors
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
