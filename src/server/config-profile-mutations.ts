import type {
  CompactGateConfig,
  ConfigProfileScope,
  SavedConfigProfile,
  SavedConfigProfileConfig
} from "../shared/types.js";
import {
  cloneProfile,
  cloneProfileConfig,
  ConfigError,
  isRecord
} from "./config-internals.js";
import {
  createProfileId,
  extractScopedProfileConfig,
  getProfileScopeState,
  mergeRuntimeForProfileScope,
  profileConfigToRuntime,
  reScopeProfileConfig,
  validateProfileConfig,
  withProfileScope
} from "./config-profile-scope.js";
import {
  routeUrlEntriesFromProfileRuntime,
  withRecordedRouteUrlPresets
} from "./config-route-presets.js";
import { mergeRuntimeConfig, validateRuntimeConfig } from "./config-runtime.js";

export function saveProfile(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  name: string,
  patch: unknown
): CompactGateConfig {
    if (!isRecord(patch)) {
      throw new ConfigError("Profile config patch must be a JSON object.");
    }

    const trimmedName = requireProfileName(name);
    const now = new Date().toISOString();
    // Merge onto the live runtime, including for a by-name overwrite.
    //
    // Deliberately NOT the target profile's own config, which looks like the
    // safer choice and is not: the Studio form is always built from the runtime
    // and never from a non-active profile, so `patch` carries the runtime's
    // base_url while omitting the untouched api_key. Basing the merge on the
    // target then files the runtime's URL beside the target's key and produces a
    // profile that 401s and cannot be repaired from the UI, because keys are
    // never returned. Overwriting means "make this profile equal my draft", and
    // the draft's blank key field means "the credential in effect for that
    // route" — which is the runtime's.
    const profileConfig = extractScopedProfileConfig(mergeRuntimeConfig(current, patch), scope);
    validateProfileConfig(profileConfig, scope);

    const scopeState = getProfileScopeState(current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    const existing = existingProfiles.find((profile) => profile.name === trimmedName);
    const nextProfile: SavedConfigProfile = {
      id: existing?.id ?? createProfileId(`${scope}-${trimmedName}`, now),
      name: trimmedName,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      config: cloneProfileConfig(profileConfig)
    };

    const nextConfig = withProfileScope(current, scope, {
      // Replaced in place rather than filtered-and-appended. List position is the
      // failover order — `codexPrimaryCandidates` derives `order` from it, and the
      // UI offers explicit drag-and-drop reordering — so overwriting B by name used
      // to move B last and silently turn A→B→C into A→C→B.
      profiles: existing
        ? existingProfiles.map((profile) =>
          profile.id === nextProfile.id ? nextProfile : cloneProfile(profile))
        : [...existingProfiles.map(cloneProfile), nextProfile],
      active_profile_id: scopeState.active_profile_id ?? null
    });
    const savedConfig =
      scopeState.active_profile_id === nextProfile.id
        ? {
            ...nextConfig,
            ...mergeRuntimeForProfileScope(nextConfig, profileConfig, scope)
          }
        : nextConfig;
    return recordProfileRouteUrls(savedConfig, profileConfig, scope);
}

export function updateProfile(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  profileId: string,
  name: string | undefined,
  patch: unknown
): CompactGateConfig {
    const { scopeState, profile } = requireProfile(current, scope, profileId);
    if (patch !== undefined && !isRecord(patch)) {
      throw new ConfigError("Profile config patch must be a JSON object.");
    }

    const existingProfiles = scopeState.profiles ?? [];
    const trimmedName = requireProfileName(typeof name === "string" ? name : profile.name);
    const duplicateName = existingProfiles.find(
      (item) => item.id !== profileId && item.name === trimmedName
    );
    if (duplicateName) {
      throw new ConfigError("Profile name already exists.");
    }

    const now = new Date().toISOString();
    // Same merge base as `saveProfile`, and for the same reason: a supplied patch
    // came from the Studio form, which is always built from the runtime and never
    // from a non-active profile. Basing it on the target's own config filed the
    // runtime's base_url beside the target's api_key — one provider's URL with
    // another's credential, a guaranteed 401 that cannot be repaired from the UI
    // because keys are never returned. Overwriting a profile means "make it equal
    // my draft", and the draft's blank key box means "the credential in effect for
    // that route".
    //
    // A rename carries no patch at all, and must leave the stored config alone —
    // merging the runtime in on a rename would silently rewrite every field of the
    // profile being renamed.
    const profileConfig = patch === undefined
      ? cloneProfileConfig(profile.config)
      : extractScopedProfileConfig(mergeRuntimeConfig(current, patch), scope);
    validateProfileConfig(profileConfig, scope);
    const nextConfig = withProfileScope(current, scope, {
      profiles: existingProfiles.map((item) =>
        item.id === profileId
          ? {
              ...item,
              name: trimmedName,
              updated_at: now,
              config: cloneProfileConfig(profileConfig)
            }
          : cloneProfile(item)
      ),
      active_profile_id: scopeState.active_profile_id ?? null
    });
    const updatedConfig =
      scopeState.active_profile_id === profileId
        ? {
            ...nextConfig,
            ...mergeRuntimeForProfileScope(nextConfig, profileConfig, scope)
          }
        : nextConfig;
    return recordProfileRouteUrls(updatedConfig, profileConfig, scope);
}

/**
 * `targetScope` re-files the copy under the other scope. Cross-scope copying runs
 * here rather than through a Studio form draft because the credential has to come
 * along: keys are never returned to a client, so a draft assembled in the browser
 * can only ever send a blank key field, which `saveProfile` then fills from
 * whichever key the *destination* route happens to be running — the source's URL
 * beside an unrelated secret. Reading the stored profile server-side is the only
 * place both halves are in hand at once.
 */
export function duplicateProfile(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  profileId: string,
  name: string | undefined,
  targetScope: ConfigProfileScope = scope
): CompactGateConfig {
    const { profile } = requireProfile(current, scope, profileId);
    const destination = getProfileScopeState(current, targetScope);
    const existingProfiles = destination.profiles ?? [];
    const now = new Date().toISOString();
    const trimmedName = requireProfileName(name?.trim() || `${profile.name} copy`);

    if (existingProfiles.some((item) => item.name === trimmedName)) {
      throw new ConfigError("Profile name already exists.");
    }

    let config: SavedConfigProfileConfig;
    if (targetScope === scope) {
      config = cloneProfileConfig(profile.config);
    } else {
      // Only the cross-scope copy is validated: it synthesizes a config shape that
      // has never been through a save, while a same-scope copy reproduces bytes
      // that were already validated when they were written.
      config = reScopeProfileConfig(profile.config, scope, targetScope);
      validateProfileConfig(config, targetScope);
    }

    const nextProfile: SavedConfigProfile = {
      id: createProfileId(`${targetScope}-${trimmedName}`, now),
      name: trimmedName,
      created_at: now,
      updated_at: now,
      config: cloneProfileConfig(config)
    };

    const nextConfig = withProfileScope(current, targetScope, {
      profiles: [...existingProfiles.map(cloneProfile), nextProfile],
      // A copy is never activated: leaving the destination's active profile alone
      // keeps a running session on the credential it started with.
      active_profile_id: destination.active_profile_id ?? null
    });
    // A cross-scope copy introduces a base_url the destination kind has not seen,
    // so its URL suggestions have to learn it the same way a save does.
    return targetScope === scope
      ? nextConfig
      : recordProfileRouteUrls(nextConfig, config, targetScope);
}

/**
 * Clear scene bindings that point at a profile being removed from the *stored
 * snapshots* of the other Claude profiles. Each Claude profile freezes a copy of
 * `claude.scene_map` and only the active one is refreshed from the runtime, so a
 * reference left inside an inactive snapshot fails validation on every later
 * mutation and makes the referenced profile permanently undeletable — with no UI
 * to reach the snapshot and clear it.
 *
 * The live `claude.scene_map` is deliberately left alone: a binding there still
 * blocks the delete, which is a guard the user can clear by unbinding the scene.
 */
function withoutStoredClaudeSceneReferences(
  config: CompactGateConfig,
  profileId: string
): CompactGateConfig {
  const scopeState = getProfileScopeState(config, "claude");
  return withProfileScope(config, "claude", {
    profiles: scopeState.profiles.map((profile) => {
      const stored = profile.config as SavedConfigProfileConfig & {
        claude?: { scene_map?: CompactGateConfig["claude"]["scene_map"] };
      };
      if (!isRecord(stored.claude) || !isRecord(stored.claude.scene_map)) {
        return profile;
      }
      return {
        ...profile,
        config: {
          ...stored,
          claude: {
            ...stored.claude,
            scene_map: clearedSceneMap(stored.claude.scene_map, profileId)
          }
        } as SavedConfigProfileConfig
      };
    }),
    active_profile_id: scopeState.active_profile_id
  });
}

function clearedSceneMap(
  sceneMap: CompactGateConfig["claude"]["scene_map"],
  profileId: string
): CompactGateConfig["claude"]["scene_map"] {
  return Object.fromEntries(
    Object.entries(sceneMap).map(([scene, target]) => [
      scene,
      target.profile_id === profileId ? { ...target, profile_id: "" } : target
    ])
  ) as CompactGateConfig["claude"]["scene_map"];
}

export function deleteProfile(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  profileId: string
): CompactGateConfig {
    const { scopeState } = requireProfile(current, scope, profileId);
    const existingProfiles = scopeState.profiles ?? [];
    const withoutProfile = withProfileScope(current, scope, {
      profiles: existingProfiles.filter((item) => item.id !== profileId).map(cloneProfile),
      active_profile_id:
        scopeState.active_profile_id === profileId
          ? null
          : scopeState.active_profile_id ?? null
    });
    return scope === "claude"
      ? withoutStoredClaudeSceneReferences(withoutProfile, profileId)
      : withoutProfile;
}

export function reorderProfiles(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  orderedProfileIds: string[]
): CompactGateConfig {
    if (!Array.isArray(orderedProfileIds) || orderedProfileIds.some((id) => typeof id !== "string")) {
      throw new ConfigError("Profile reorder requires a profile_id list.");
    }

    const scopeState = getProfileScopeState(current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    if (orderedProfileIds.length !== existingProfiles.length) {
      throw new ConfigError("Profile reorder must include every profile exactly once.");
    }

    const profilesById = new Map(existingProfiles.map((profile) => [profile.id, profile]));
    const seenIds = new Set<string>();
    const reorderedProfiles: SavedConfigProfile[] = [];

    for (const rawId of orderedProfileIds) {
      const orderedProfileId = rawId.trim();
      if (!orderedProfileId || seenIds.has(orderedProfileId)) {
        throw new ConfigError("Profile reorder ids must be unique.");
      }

      const profile = profilesById.get(orderedProfileId);
      if (!profile) {
        throw new ConfigError("Profile reorder ids must match existing profiles.");
      }

      seenIds.add(orderedProfileId);
      reorderedProfiles.push(cloneProfile(profile));
    }

    return withProfileScope(current, scope, {
      profiles: reorderedProfiles,
      active_profile_id: scopeState.active_profile_id ?? null
    });
}

export function applyProfile(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  profileId: string
): CompactGateConfig {
    const { scopeState, profile } = requireProfile(current, scope, profileId);
    const nextRuntime = mergeRuntimeForProfileScope(current, profile.config, scope);
    validateRuntimeConfig(nextRuntime);
    return withProfileScope(
      {
        ...nextRuntime,
        profile_scopes: current.profile_scopes,
        route_url_presets: current.route_url_presets
      },
      scope,
      {
        profiles: scopeState.profiles ?? [],
        active_profile_id: profile.id
      }
    );
}

function requireProfile(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  profileId: string
): {
    scopeState: { profiles: SavedConfigProfile[]; active_profile_id: string | null };
    profile: SavedConfigProfile;
  } {
    const scopeState = getProfileScopeState(current, scope);
    const profile = (scopeState.profiles ?? []).find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.", 404);
    }

    return { scopeState, profile };
}

function recordProfileRouteUrls(
  config: CompactGateConfig,
  profileConfig: SavedConfigProfileConfig,
  scope: ConfigProfileScope
): CompactGateConfig {
    return withRecordedRouteUrlPresets(
      config,
      routeUrlEntriesFromProfileRuntime(profileConfigToRuntime(profileConfig), scope)
    );
}

function requireProfileName(name: string): string {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new ConfigError("Profile name is required.");
  }

  return trimmedName;
}
