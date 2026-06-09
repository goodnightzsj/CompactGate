import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig,
  RouteUrlPreset,
  SavedConfigProfile,
  SavedConfigProfileConfig
} from "../shared/types.js";
import {
  cloneConfig,
  cloneProfile,
  cloneProfileConfig
} from "./config-clone.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { ConfigError } from "./config-error.js";
import {
  PROFILE_SCOPES,
  normalizeProfileIdArgs,
  normalizeProfileIdNameArgs,
  normalizeProfileMutationArgs,
  normalizeProfileOperationArgs
} from "./config-profile-args.js";
import { createProfileScopeHelpers } from "./config-profile-scope.js";
import { buildPublicConfig } from "./config-public.js";
import {
  isRouteUrlPresetKind,
  mergeRouteUrlPresets,
  routeUrlEntriesFromProfileConfig,
  routeUrlEntriesFromRuntime,
  withRecordedRouteUrlPresets
} from "./config-route-presets.js";
import { isRecord } from "./config-readers.js";
import {
  mergeRuntimeConfig,
  parseListenAddress,
  validateBaseUrl,
  validateRuntimeConfig
} from "./config-runtime.js";

export { ConfigError } from "./config-error.js";
export { DEFAULT_CONFIG } from "./config-defaults.js";
export { parseListenAddress } from "./config-runtime.js";

const {
  createProfileId,
  createScopedProfileConfig,
  getProfileScopeState,
  mergeProfileScopes,
  mergeRuntimeForProfileScope,
  profileConfigToRuntime,
  shouldPersistProfileNormalization,
  syncActiveProfilesFromRuntime,
  updateScopedProfileConfig,
  validateProfileConfig,
  withProfileScope
} = createProfileScopeHelpers({
  mergeRuntimeConfig,
  validateRuntimeConfig
});

export class ConfigStore {
  private current: CompactGateConfig;

  private lastSavedAt: string | null = null;

  private constructor(
    private readonly configPath: string,
    initial: CompactGateConfig
  ) {
    this.current = initial;
  }

  static async load(configPath: string): Promise<ConfigStore> {
    const resolvedPath = path.resolve(configPath);
    let config = DEFAULT_CONFIG;
    let shouldPersistNormalizedProfiles = false;

    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      const parsed = JSON.parse(raw);
      config = mergeConfig(DEFAULT_CONFIG, parsed);
      shouldPersistNormalizedProfiles = shouldPersistProfileNormalization(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    validateConfig(config);
    const store = new ConfigStore(resolvedPath, config);
    if (shouldPersistNormalizedProfiles) {
      await store.save();
    }
    return store;
  }

  get(): CompactGateConfig {
    return cloneConfig(this.current);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async patch(patch: unknown): Promise<CompactGateConfig> {
    if (!isRecord(patch)) {
      throw new ConfigError("Config patch must be a JSON object.");
    }

    const merged = mergeConfig(this.current, patch);
    const next = withRecordedRouteUrlPresets(syncActiveProfilesFromRuntime({
      ...merged,
      profiles: undefined,
      active_profile_id: merged.profile_scopes?.codex?.active_profile_id ?? null
    }), routeUrlEntriesFromRuntime(merged));
    validateConfig(next);
    this.current = next;
    await this.save();
    return this.get();
  }

  async importConfig(value: unknown): Promise<CompactGateConfig> {
    if (!isRecord(value)) {
      throw new ConfigError("Imported config must be a JSON object.");
    }

    const merged = mergeConfig(DEFAULT_CONFIG, value);
    const imported = {
      ...merged,
      profiles: undefined,
      active_profile_id: merged.profile_scopes?.codex?.active_profile_id ?? null
    };
    validateConfig(imported);
    this.current = imported;
    await this.save();
    return this.get();
  }

  async saveProfile(
    scopeOrName: ConfigProfileScope | string,
    nameOrPatch: string | unknown,
    maybePatch?: unknown
  ): Promise<CompactGateConfig> {
    const { scope, name, patch } = normalizeProfileOperationArgs(scopeOrName, nameOrPatch, maybePatch);
    return this.saveScopedProfile(scope, name, patch);
  }

  private async saveScopedProfile(scope: ConfigProfileScope, name: string, patch: unknown): Promise<CompactGateConfig> {
    if (!isRecord(patch)) {
      throw new ConfigError("Profile config patch must be a JSON object.");
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new ConfigError("Profile name is required.");
    }

    const now = new Date().toISOString();
    const profileConfig = createScopedProfileConfig(this.current, patch, scope);
    validateProfileConfig(profileConfig, scope);

    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    const existing = existingProfiles.find((profile) => profile.name === trimmedName);
    const nextProfile: SavedConfigProfile = {
      id: existing?.id ?? createProfileId(`${scope}-${trimmedName}`, now),
      name: trimmedName,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      config: cloneProfileConfig(profileConfig)
    };

    const nextScopeState = {
      profiles: [
        ...existingProfiles.filter((profile) => profile.id !== nextProfile.id).map(cloneProfile),
        nextProfile
      ],
      active_profile_id: scopeState.active_profile_id ?? null
    };
    const nextConfig = withProfileScope(this.current, scope, nextScopeState);
    this.current =
      scopeState.active_profile_id === nextProfile.id
        ? {
            ...nextConfig,
            ...mergeRuntimeForProfileScope(nextConfig, profileConfig, scope)
          }
        : nextConfig;
    this.current = withRecordedRouteUrlPresets(
      this.current,
      routeUrlEntriesFromProfileConfig(profileConfig, scope, profileConfigToRuntime)
    );
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async updateProfile(
    scopeOrProfileId: ConfigProfileScope | string,
    profileIdOrName: string | undefined,
    nameOrPatch?: string | unknown,
    maybePatch?: unknown
  ): Promise<CompactGateConfig> {
    const { scope, profileId, name, patch } = normalizeProfileMutationArgs(
      scopeOrProfileId,
      profileIdOrName,
      nameOrPatch,
      maybePatch
    );
    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    const profile = existingProfiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    if (!isRecord(patch)) {
      throw new ConfigError("Profile config patch must be a JSON object.");
    }

    const trimmedName = typeof name === "string" ? name.trim() : profile.name;
    if (trimmedName.length === 0) {
      throw new ConfigError("Profile name is required.");
    }

    const duplicateName = existingProfiles.find(
      (item) => item.id !== profileId && item.name === trimmedName
    );
    if (duplicateName) {
      throw new ConfigError("Profile name already exists.");
    }

    const now = new Date().toISOString();
    const profileConfig = updateScopedProfileConfig(profile.config, patch, scope);
    validateProfileConfig(profileConfig, scope);
    const nextScopeState = {
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
    };

    const nextConfig = withProfileScope(this.current, scope, nextScopeState);
    this.current =
      scopeState.active_profile_id === profileId
        ? {
            ...nextConfig,
            ...mergeRuntimeForProfileScope(nextConfig, profileConfig, scope)
          }
        : nextConfig;
    this.current = withRecordedRouteUrlPresets(
      this.current,
      routeUrlEntriesFromProfileConfig(profileConfig, scope, profileConfigToRuntime)
    );
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async duplicateProfile(
    scopeOrProfileId: ConfigProfileScope | string,
    profileIdOrName?: string,
    maybeName?: string
  ): Promise<CompactGateConfig> {
    const { scope, profileId, name } = normalizeProfileIdNameArgs(scopeOrProfileId, profileIdOrName, maybeName);
    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    const profile = existingProfiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    const now = new Date().toISOString();
    const trimmedName = (name?.trim() || `${profile.name} copy`).trim();
    if (trimmedName.length === 0) {
      throw new ConfigError("Profile name is required.");
    }

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

    this.current = withProfileScope(this.current, scope, {
      profiles: [...existingProfiles.map(cloneProfile), nextProfile],
      active_profile_id: scopeState.active_profile_id ?? null
    });
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async deleteProfile(scopeOrProfileId: ConfigProfileScope | string, maybeProfileId?: string): Promise<CompactGateConfig> {
    const { scope, profileId } = normalizeProfileIdArgs(scopeOrProfileId, maybeProfileId);
    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    const profile = existingProfiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    this.current = withProfileScope(this.current, scope, {
      profiles: existingProfiles.filter((item) => item.id !== profileId).map(cloneProfile),
      active_profile_id:
        scopeState.active_profile_id === profileId
          ? null
          : scopeState.active_profile_id ?? null
    });
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async reorderProfiles(scope: ConfigProfileScope, orderedProfileIds: string[]): Promise<CompactGateConfig> {
    if (!Array.isArray(orderedProfileIds) || orderedProfileIds.some((id) => typeof id !== "string")) {
      throw new ConfigError("Profile reorder requires a profile_id list.");
    }

    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    if (orderedProfileIds.length !== existingProfiles.length) {
      throw new ConfigError("Profile reorder must include every profile exactly once.");
    }

    const profilesById = new Map(existingProfiles.map((profile) => [profile.id, profile]));
    const seenIds = new Set<string>();
    const reorderedProfiles: SavedConfigProfile[] = [];

    for (const rawId of orderedProfileIds) {
      const profileId = rawId.trim();
      if (!profileId || seenIds.has(profileId)) {
        throw new ConfigError("Profile reorder ids must be unique.");
      }

      const profile = profilesById.get(profileId);
      if (!profile) {
        throw new ConfigError("Profile reorder ids must match existing profiles.");
      }

      seenIds.add(profileId);
      reorderedProfiles.push(cloneProfile(profile));
    }

    this.current = withProfileScope(this.current, scope, {
      profiles: reorderedProfiles,
      active_profile_id: scopeState.active_profile_id ?? null
    });
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async applyProfile(scopeOrProfileId: ConfigProfileScope | string, maybeProfileId?: string): Promise<CompactGateConfig> {
    const { scope, profileId } = normalizeProfileIdArgs(scopeOrProfileId, maybeProfileId);
    const scopeState = getProfileScopeState(this.current, scope);
    const profile = (scopeState.profiles ?? []).find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    const nextRuntime = mergeRuntimeForProfileScope(this.current, profile.config, scope);
    validateRuntimeConfig(nextRuntime);
    this.current = withProfileScope(
      {
        ...nextRuntime,
        profile_scopes: this.current.profile_scopes,
        route_url_presets: this.current.route_url_presets
      },
      scope,
      {
        profiles: scopeState.profiles ?? [],
        active_profile_id: profile.id
      }
    );
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  toPublicConfig(): PublicConfig {
    return buildPublicConfig({
      config: this.get(),
      configPath: this.configPath,
      lastSavedAt: this.lastSavedAt,
      getProfileScopeState,
      profileConfigToRuntime
    });
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(
      this.configPath,
      `${JSON.stringify(this.current, null, 2)}\n`,
      "utf8"
    );
    this.lastSavedAt = new Date().toISOString();
  }
}

export function validateConfig(config: CompactGateConfig): void {
  validateRuntimeConfig(config);

  for (const preset of config.route_url_presets ?? []) {
    validateRouteUrlPreset(preset);
  }

  for (const scope of PROFILE_SCOPES) {
    const state = getProfileScopeState(config, scope);
    for (const profile of state.profiles) {
      if (profile.id.trim().length === 0) {
        throw new ConfigError("profile.id is required.");
      }

      if (profile.name.trim().length === 0) {
        throw new ConfigError("profile.name is required.");
      }

      validateProfileConfig(profile.config, scope);
    }

    if (state.active_profile_id && !state.profiles.some((profile) => profile.id === state.active_profile_id)) {
      throw new ConfigError(`${scope}.active_profile_id must reference an existing profile.`);
    }
  }
}

function validateRouteUrlPreset(preset: RouteUrlPreset): void {
  validateRouteUrlPresetKind(preset.kind);
  validateBaseUrl(preset.base_url, `route_url_presets.${preset.kind}.base_url`);

  if (!Number.isInteger(preset.usage_count) || preset.usage_count < 1) {
    throw new ConfigError("route_url_presets.usage_count must be a positive integer.");
  }
}

function validateRouteUrlPresetKind(value: string): void {
  if (!isRouteUrlPresetKind(value)) {
    throw new ConfigError("route_url_presets.kind must be a known route URL preset kind.");
  }
}

function mergeConfig(base: CompactGateConfig, patch: unknown): CompactGateConfig {
  const patchRecord = isRecord(patch) ? patch : {};
  const runtime = mergeRuntimeConfig(base, patchRecord);
  const profileScopes = mergeProfileScopes(base, patchRecord);

  return {
    ...runtime,
    profiles: undefined,
    active_profile_id: profileScopes.codex?.active_profile_id ?? null,
    profile_scopes: profileScopes,
    route_url_presets: mergeRouteUrlPresets(base.route_url_presets, patchRecord.route_url_presets)
  };
}
