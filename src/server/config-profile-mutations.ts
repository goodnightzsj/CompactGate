import type {
  CompactGateConfig,
  ConfigProfileScope,
  SavedConfigProfile,
  SavedConfigProfileConfig
} from "../shared/types.js";
import {
  cloneProfile,
  cloneProfileConfig
} from "./config-clone.js";
import { ConfigError } from "./config-error.js";
import {
  createProfileId,
  createScopedProfileConfig,
  getProfileScopeState,
  mergeRuntimeForProfileScope,
  profileConfigToRuntime,
  updateScopedProfileConfig,
  validateProfileConfig,
  withProfileScope
} from "./config-profile-scope.js";
import {
  routeUrlEntriesFromProfileConfig,
  withRecordedRouteUrlPresets
} from "./config-route-presets.js";
import { isRecord } from "./config-readers.js";
import { validateRuntimeConfig } from "./config-runtime.js";

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
    const profileConfig = createScopedProfileConfig(current, patch, scope);
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
      profiles: [
        ...existingProfiles.filter((profile) => profile.id !== nextProfile.id).map(cloneProfile),
        nextProfile
      ],
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
    if (!isRecord(patch)) {
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
    const profileConfig = updateScopedProfileConfig(profile.config, patch, scope);
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

export function duplicateProfile(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  profileId: string,
  name: string | undefined
): CompactGateConfig {
    const { scopeState, profile } = requireProfile(current, scope, profileId);
    const existingProfiles = scopeState.profiles ?? [];
    const now = new Date().toISOString();
    const trimmedName = requireProfileName(name?.trim() || `${profile.name} copy`);

    if (existingProfiles.some((item) => item.name === trimmedName)) {
      throw new ConfigError("Profile name already exists.");
    }

    const nextProfile: SavedConfigProfile = {
      id: createProfileId(`${scope}-${trimmedName}`, now),
      name: trimmedName,
      created_at: now,
      updated_at: now,
      config: cloneProfileConfig(profile.config)
    };

    return withProfileScope(current, scope, {
      profiles: [...existingProfiles.map(cloneProfile), nextProfile],
      active_profile_id: scopeState.active_profile_id ?? null
    });
}

export function deleteProfile(
  current: CompactGateConfig,
  scope: ConfigProfileScope,
  profileId: string
): CompactGateConfig {
    const { scopeState } = requireProfile(current, scope, profileId);
    const existingProfiles = scopeState.profiles ?? [];
    return withProfileScope(current, scope, {
      profiles: existingProfiles.filter((item) => item.id !== profileId).map(cloneProfile),
      active_profile_id:
        scopeState.active_profile_id === profileId
          ? null
          : scopeState.active_profile_id ?? null
    });
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
      throw new ConfigError("Profile not found.");
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
      routeUrlEntriesFromProfileConfig(profileConfig, scope, profileConfigToRuntime)
    );
}

function requireProfileName(name: string): string {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new ConfigError("Profile name is required.");
  }

  return trimmedName;
}
