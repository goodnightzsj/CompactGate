import type {
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig,
  RouteUrlPreset
} from "../shared/types.js";
import {
  cloneConfig
} from "./config-clone.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { ConfigError } from "./config-error.js";
import {
  readConfigFile,
  writeConfigFile
} from "./config-file-repository.js";
import {
  PROFILE_SCOPES,
  normalizeProfileIdArgs,
  normalizeProfileIdNameArgs,
  normalizeProfileMutationArgs,
  normalizeProfileOperationArgs
} from "./config-profile-args.js";
import {
  applyProfile as applyConfigProfile,
  deleteProfile as deleteConfigProfile,
  duplicateProfile as duplicateConfigProfile,
  reorderProfiles as reorderConfigProfiles,
  saveProfile as saveConfigProfile,
  updateProfile as updateConfigProfile
} from "./config-profile-mutations.js";
import {
  getProfileScopeState,
  mergeProfileScopes,
  profileConfigToRuntime,
  shouldPersistProfileNormalization,
  syncActiveProfilesFromRuntime,
  validateProfileConfig
} from "./config-profile-scope.js";
import { buildPublicConfig } from "./config-public.js";
import {
  isRouteUrlPresetKind,
  mergeRouteUrlPresets,
  routeUrlEntriesFromRuntime,
  withRecordedRouteUrlPresets
} from "./config-route-presets.js";
import { isRecord } from "./config-readers.js";
import {
  mergeRuntimeConfig,
  validateBaseUrl,
  validateRuntimeConfig
} from "./config-runtime.js";

export { ConfigError } from "./config-error.js";
export { DEFAULT_CONFIG } from "./config-defaults.js";
export { parseListenAddress } from "./config-runtime.js";

export class ConfigStore {
  private current: CompactGateConfig;

  private lastSavedAt: string | null = null;

  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly configPath: string,
    initial: CompactGateConfig
  ) {
    this.current = initial;
  }

  static async load(configPath: string): Promise<ConfigStore> {
    const loaded = await readConfigFile(configPath);
    let config = DEFAULT_CONFIG;
    let shouldPersistNormalizedProfiles = false;

    if (!loaded.missing) {
      config = mergeConfig(DEFAULT_CONFIG, loaded.value);
      shouldPersistNormalizedProfiles = shouldPersistProfileNormalization(loaded.value);
    }

    validateConfig(config);
    const store = new ConfigStore(loaded.resolvedPath, config);
    if (shouldPersistNormalizedProfiles) {
      await store.persist(config);
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

    return this.mutate(() => {
      const merged = mergeConfig(this.current, patch);
      return withRecordedRouteUrlPresets(syncActiveProfilesFromRuntime({
        ...merged,
        profiles: undefined,
        active_profile_id: merged.profile_scopes?.codex?.active_profile_id ?? null
      }), routeUrlEntriesFromRuntime(merged));
    });
  }

  async importConfig(value: unknown): Promise<CompactGateConfig> {
    if (!isRecord(value)) {
      throw new ConfigError("Imported config must be a JSON object.");
    }

    return this.mutate(() => {
      const merged = mergeConfig(DEFAULT_CONFIG, value);
      return {
        ...merged,
        profiles: undefined,
        active_profile_id: merged.profile_scopes?.codex?.active_profile_id ?? null
      };
    });
  }

  async saveProfile(
    scopeOrName: ConfigProfileScope | string,
    nameOrPatch: string | unknown,
    maybePatch?: unknown
  ): Promise<CompactGateConfig> {
    const { scope, name, patch } = normalizeProfileOperationArgs(scopeOrName, nameOrPatch, maybePatch);
    return this.mutate(() => saveConfigProfile(this.current, scope, name, patch));
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
    return this.mutate(() => updateConfigProfile(this.current, scope, profileId, name, patch));
  }

  async duplicateProfile(
    scopeOrProfileId: ConfigProfileScope | string,
    profileIdOrName?: string,
    maybeName?: string
  ): Promise<CompactGateConfig> {
    const { scope, profileId, name } = normalizeProfileIdNameArgs(scopeOrProfileId, profileIdOrName, maybeName);
    return this.mutate(() => duplicateConfigProfile(this.current, scope, profileId, name));
  }

  async deleteProfile(scopeOrProfileId: ConfigProfileScope | string, maybeProfileId?: string): Promise<CompactGateConfig> {
    const { scope, profileId } = normalizeProfileIdArgs(scopeOrProfileId, maybeProfileId);
    return this.mutate(() => deleteConfigProfile(this.current, scope, profileId));
  }

  async reorderProfiles(scope: ConfigProfileScope, orderedProfileIds: string[]): Promise<CompactGateConfig> {
    return this.mutate(() => reorderConfigProfiles(this.current, scope, orderedProfileIds));
  }

  async applyProfile(scopeOrProfileId: ConfigProfileScope | string, maybeProfileId?: string): Promise<CompactGateConfig> {
    const { scope, profileId } = normalizeProfileIdArgs(scopeOrProfileId, maybeProfileId);
    return this.mutate(() => applyConfigProfile(this.current, scope, profileId));
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

  private async mutate(buildNext: () => CompactGateConfig): Promise<CompactGateConfig> {
    const mutation = this.mutationQueue.catch(() => undefined).then(async () => {
      const next = buildNext();
      validateConfig(next);
      return this.persist(next);
    });
    this.mutationQueue = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  private async persist(next: CompactGateConfig): Promise<CompactGateConfig> {
    const savedAt = await writeConfigFile(this.configPath, next);
    this.current = next;
    this.lastSavedAt = savedAt;
    return this.get();
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
