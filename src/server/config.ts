import type {
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig,
  RouteUrlPreset
} from "../shared/types.js";
import { cloneConfig, ConfigError, isRecord } from "./config-internals.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import {
  deleteConfigBackup,
  listConfigBackups,
  readConfigBackup,
  readConfigFile,
  writeConfigFile,
  type ConfigBackupMetadata
} from "./config-file-repository.js";
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
  syncActiveProfilesFromRuntime,
  validateProfileConfig
} from "./config-profile-scope.js";
import { buildPublicConfig } from "./config-public.js";
import {
  applyRouteUrlCredentialPresetBindings,
  isRouteUrlPresetKind,
  mergeRouteUrlPresets,
  routeUrlEntriesFromRuntime,
  withRecordedRouteUrlPresets
} from "./config-route-presets.js";
import {
  mergeRuntimeConfig,
  validateBaseUrl,
  validateRuntimeConfig
} from "./config-runtime.js";

export { ConfigError } from "./config-internals.js";
export { DEFAULT_CONFIG } from "./config-defaults.js";
export { parseListenAddress } from "./config-runtime.js";

export class ConfigStore {
  private current: CompactGateConfig;

  private lastSavedAt: string | null = null;

  /**
   * Bumped on every successful mutation so a client can pin the snapshot its
   * patch was built from. The boot half is seeded from the wall clock rather
   * than a constant: after a restart the counter must not walk back through
   * values a still-open Studio tab is holding, or a stale patch would look
   * current again.
   */
  private readonly revisionBoot = Date.now().toString(36);

  private revisionCounter = 0;

  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly configPath: string,
    initial: CompactGateConfig
  ) {
    this.current = initial;
  }

  static async load(configPath: string): Promise<ConfigStore> {
    const loaded = await readConfigFile(configPath);
    const config = loaded.missing ? DEFAULT_CONFIG : mergeConfig(DEFAULT_CONFIG, loaded.value);

    validateConfig(config);
    return new ConfigStore(loaded.resolvedPath, config);
  }

  get(): CompactGateConfig {
    return cloneConfig(this.current);
  }

  get revision(): string {
    return `r${this.revisionBoot}-${this.revisionCounter}`;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async patch(patch: unknown): Promise<CompactGateConfig> {
    if (!isRecord(patch)) {
      throw new ConfigError("Config patch must be a JSON object.");
    }

    return this.mutate(() => {
      // Inside the mutation queue: checking before queueing would let two
      // concurrent patches both pass against the same revision.
      this.assertRevisionCurrent(patch.revision);
      const merged = mergeConfig(this.current, applyRouteUrlCredentialPresetBindings(this.current, patch));
      return withRecordedRouteUrlPresets(syncActiveProfilesFromRuntime({
        ...merged,
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
        active_profile_id: merged.profile_scopes?.codex?.active_profile_id ?? null
      };
    });
  }

  async saveProfile(
    scope: ConfigProfileScope,
    name: string,
    patch: unknown
  ): Promise<CompactGateConfig> {
    return this.mutate(() =>
      saveConfigProfile(this.current, scope, name, applyRouteUrlCredentialPresetBindings(this.current, patch))
    );
  }

  async updateProfile(
    scope: ConfigProfileScope,
    profileId: string,
    name: string | undefined,
    patch: unknown
  ): Promise<CompactGateConfig> {
    return this.mutate(() =>
      updateConfigProfile(
        this.current,
        scope,
        profileId,
        name,
        applyRouteUrlCredentialPresetBindings(this.current, patch)
      )
    );
  }

  async duplicateProfile(
    scope: ConfigProfileScope,
    profileId: string,
    name?: string
  ): Promise<CompactGateConfig> {
    return this.mutate(() => duplicateConfigProfile(this.current, scope, profileId, name));
  }

  async deleteProfile(scope: ConfigProfileScope, profileId: string): Promise<CompactGateConfig> {
    return this.mutate(() => deleteConfigProfile(this.current, scope, profileId));
  }

  async reorderProfiles(scope: ConfigProfileScope, orderedProfileIds: string[]): Promise<CompactGateConfig> {
    return this.mutate(() => reorderConfigProfiles(this.current, scope, orderedProfileIds));
  }

  async applyProfile(scope: ConfigProfileScope, profileId: string): Promise<CompactGateConfig> {
    return this.mutate(() => applyConfigProfile(this.current, scope, profileId));
  }

  async listBackups(): Promise<ConfigBackupMetadata[]> {
    await this.mutationQueue;
    return listConfigBackups(this.configPath);
  }

  async restoreBackup(backupId: string): Promise<CompactGateConfig> {
    return this.queue(async () => {
      let value: unknown;
      try {
        value = await readConfigBackup(this.configPath, backupId);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new ConfigError("Config backup must contain valid JSON.");
        }
        throw error;
      }

      const next = mergeConfig(DEFAULT_CONFIG, value);
      validateConfig(next);
      return this.persist(next);
    });
  }

  async deleteBackup(backupId: string): Promise<void> {
    return this.queue(() => deleteConfigBackup(this.configPath, backupId));
  }

  toPublicConfig(): PublicConfig {
    return buildPublicConfig({
      config: this.get(),
      configPath: this.configPath,
      lastSavedAt: this.lastSavedAt,
      revision: this.revision
    });
  }

  private assertRevisionCurrent(revision: unknown): void {
    if (revision === undefined || revision === null) {
      return;
    }

    if (typeof revision !== "string") {
      throw new ConfigError("Config patch revision must be a string.");
    }

    if (revision !== this.revision) {
      throw new ConfigError(
        "Config patch was built from a superseded revision. Reload the config and reapply the change."
      );
    }
  }

  private async mutate(buildNext: () => CompactGateConfig): Promise<CompactGateConfig> {
    return this.queue(async () => {
      const next = buildNext();
      validateConfig(next);
      return this.persist(next);
    });
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  private async persist(next: CompactGateConfig): Promise<CompactGateConfig> {
    const savedAt = await writeConfigFile(this.configPath, next);
    this.current = next;
    this.lastSavedAt = savedAt;
    this.revisionCounter += 1;
    return this.get();
  }
}

export function validateConfig(config: CompactGateConfig): void {
  validateRuntimeConfig(config);

  for (const preset of config.route_url_presets ?? []) {
    validateRouteUrlPreset(preset);
  }

  for (const scope of ["codex", "claude"] as const) {
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

  validateClaudeSceneProfileReferences(config);
}

function validateClaudeSceneProfileReferences(config: CompactGateConfig): void {
  const state = getProfileScopeState(config, "claude");
  const profileIds = new Set(state.profiles.map((profile) => profile.id));
  validateSceneReferences(config.claude.scene_map, profileIds, "claude.scene_map");
  for (const profile of state.profiles) {
    validateSceneReferences(
      profileConfigToRuntime(profile.config).claude.scene_map,
      profileIds,
      `profile_scopes.claude.${profile.id}.scene_map`
    );
  }
}

function validateSceneReferences(
  sceneMap: CompactGateConfig["claude"]["scene_map"],
  profileIds: Set<string>,
  field: string
): void {
  for (const [scene, target] of Object.entries(sceneMap)) {
    if (target.profile_id && !profileIds.has(target.profile_id)) {
      throw new ConfigError(`${field}.${scene}.profile_id must reference an existing Claude profile.`);
    }
  }
}

function validateRouteUrlPreset(preset: RouteUrlPreset): void {
  if (!isRouteUrlPresetKind(preset.kind)) {
    throw new ConfigError("route_url_presets.kind must be a known route URL preset kind.");
  }
  validateBaseUrl(preset.base_url, `route_url_presets.${preset.kind}.base_url`);

  if (!Number.isInteger(preset.usage_count) || preset.usage_count < 1) {
    throw new ConfigError("route_url_presets.usage_count must be a positive integer.");
  }

  if (
    preset.api_key_env.trim().length > 0 &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(preset.api_key_env)
  ) {
    throw new ConfigError("route_url_presets.api_key_env must be an environment variable name.");
  }
}

function mergeConfig(base: CompactGateConfig, patch: unknown): CompactGateConfig {
  const patchRecord = isRecord(patch) ? patch : {};
  const runtime = mergeRuntimeConfig(base, patchRecord);
  const profileScopes = mergeProfileScopes(base, patchRecord);

  return {
    ...runtime,
    active_profile_id: profileScopes.codex?.active_profile_id ?? null,
    profile_scopes: profileScopes,
    route_url_presets: mergeRouteUrlPresets(base.route_url_presets, patchRecord.route_url_presets)
  };
}
