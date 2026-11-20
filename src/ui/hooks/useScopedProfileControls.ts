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
  readonly selectionRevision: number;
  readonly interactionRevision: number;
  state: ProfileActionState;
  setName: (name: string) => void;
  commitSavedName: (expected: Pick<ScopedProfileAccessors, "name" | "selectedId" | "selectionRevision">, profileId: string, name: string) => void;
  setSelectedId: (value: SetStateAction<string>, expected?: Pick<ScopedProfileAccessors, "name" | "selectedId" | "interactionRevision">) => void;
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
  const selectionRevision = useRef(0);
  const interactionRevision = useRef(0);
  const [nameState, setNameState] = useState<ProfileNameSyncResult>({
    name: "", selectedId: "", sourceProfileId: null, dirty: false
  });
  const { name, selectedId } = nameState;
  const [state, setState] = useState<ProfileActionState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) {
      return;
    }

    const scopeState = profileScopeState(config, scope);
    setNameState((current) => {
      const next = nextProfileNameSyncState({
        ...current,
        profiles: scopeState.profiles,
        activeProfileId: scopeState.active_profile_id
      });
      return next.name === current.name && next.selectedId === current.selectedId
        && next.sourceProfileId === current.sourceProfileId && next.dirty === current.dirty
        ? current : next;
    });
  }, [config, nameState, scope]);

  return {
    error,
    name,
    selectedId,
    state,
    setDraftName(nextName: string): void {
      interactionRevision.current += 1;
      setNameState((current) => ({ ...current, name: nextName, dirty: true }));
    },
    accessors: {
      name,
      selectedId,
      get selectionRevision() { return selectionRevision.current; },
      get interactionRevision() { return interactionRevision.current; },
      state,
      setName(nextName: string): void {
        interactionRevision.current += 1;
        setNameState((current) => ({ ...current, name: nextName, sourceProfileId: null, dirty: false }));
      },
      commitSavedName(expected, profileId, savedName): void {
        setNameState((current) => {
          // Selection round trips supersede a save; name-only edits still bind to the saved ID.
          if (selectionRevision.current !== expected.selectionRevision
            || current.selectedId !== expected.selectedId) return current;
          const edited = current.name !== expected.name;
          return {
            selectedId: profileId,
            sourceProfileId: profileId || null,
            name: edited ? current.name : savedName,
            dirty: edited
          };
        });
      },
      setSelectedId(value, expected): void {
        if (!expected) {
          selectionRevision.current += 1;
          interactionRevision.current += 1;
        }
        setNameState((current) => {
          // Returning to the same selection/name still supersedes pending auto-selection.
          if (expected && (interactionRevision.current !== expected.interactionRevision
            || current.selectedId !== expected.selectedId || current.name !== expected.name)) return current;
          return { ...current, selectedId: typeof value === "function" ? value(current.selectedId) : value };
        });
      },
      setState,
      setError
    } satisfies ScopedProfileAccessors
  };
}

export function nextProfileNameSyncState(input: ProfileNameSyncInput): ProfileNameSyncResult {
  // A first profile can arrive over SSE before its save response. Keep the
  // unbound creation draft until that response or an explicit selection binds it.
  if (input.dirty && !input.selectedId && input.sourceProfileId === null) {
    return { selectedId: "", name: input.name, sourceProfileId: null, dirty: true };
  }
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
