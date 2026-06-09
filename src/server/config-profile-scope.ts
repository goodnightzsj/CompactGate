import type {
  CompactGateConfig,
  CompactGateRuntimeConfig,
  ConfigProfileScope,
  SavedClaudeProfileConfig,
  SavedCodexProfileConfig,
  SavedConfigProfile,
  SavedConfigProfileConfig,
  SavedConfigProfileScopeState,
  SavedConfigProfileScopes
} from "../shared/types.js";
import {
  cloneProfile,
  cloneProfileConfig,
  cloneProfileScope,
  cloneRuntimeConfig
} from "./config-clone.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { cloneRouteUrlPreset } from "./config-route-presets.js";
import { isRecord, readChild, readString } from "./config-readers.js";

type MergeRuntimeConfig = (
  base: CompactGateRuntimeConfig,
  patch: unknown
) => CompactGateRuntimeConfig;

type ValidateRuntimeConfig = (config: CompactGateRuntimeConfig) => void;

export function createProfileScopeHelpers({
  mergeRuntimeConfig,
  validateRuntimeConfig
}: {
  mergeRuntimeConfig: MergeRuntimeConfig;
  validateRuntimeConfig: ValidateRuntimeConfig;
}) {
  function mergeRuntimeForProfileScope(
    current: CompactGateRuntimeConfig,
    profile: SavedConfigProfileConfig,
    scope: ConfigProfileScope
  ): CompactGateRuntimeConfig {
    const profileRuntime = profileConfigToRuntime(profile);

    if (scope === "codex") {
      return {
        ...cloneRuntimeConfig(current),
        primary: { ...profileRuntime.primary },
        compact: { ...profileRuntime.compact }
      };
    }

    return {
      ...cloneRuntimeConfig(current),
      claude: {
        primary: { ...profileRuntime.claude.primary },
        compact: { ...profileRuntime.claude.compact },
        model_map: { ...profileRuntime.claude.model_map }
      }
    };
  }

  function createScopedProfileConfig(
    current: CompactGateRuntimeConfig,
    patch: unknown,
    scope: ConfigProfileScope
  ): SavedConfigProfileConfig {
    return extractScopedProfileConfig(mergeRuntimeConfig(current, patch), scope);
  }

  function updateScopedProfileConfig(
    current: SavedConfigProfileConfig,
    patch: unknown,
    scope: ConfigProfileScope
  ): SavedConfigProfileConfig {
    return extractScopedProfileConfig(mergeRuntimeConfig(profileConfigToRuntime(current), patch), scope);
  }

  function extractScopedProfileConfig(
    runtime: CompactGateRuntimeConfig,
    scope: ConfigProfileScope
  ): SavedCodexProfileConfig | SavedClaudeProfileConfig {
    if (scope === "codex") {
      return {
        primary: { ...runtime.primary },
        compact: { ...runtime.compact }
      };
    }

    return {
      claude: {
        primary: { ...runtime.claude.primary },
        compact: { ...runtime.claude.compact },
        model_map: { ...runtime.claude.model_map }
      }
    };
  }

  function profileConfigToRuntime(config: SavedConfigProfileConfig): CompactGateRuntimeConfig {
    return mergeRuntimeConfig(DEFAULT_CONFIG, config);
  }

  function validateProfileConfig(config: SavedConfigProfileConfig, scope: ConfigProfileScope): void {
    validateRuntimeConfig(profileConfigToRuntime(extractScopedProfileConfig(profileConfigToRuntime(config), scope)));
  }

  function shouldPersistProfileNormalization(value: unknown): boolean {
    if (!isRecord(value)) {
      return false;
    }

    if (Array.isArray(value.profiles)) {
      return true;
    }

    const profileScopes = readChild(value.profile_scopes);
    return (
      profileScopeNeedsNormalization(readChild(profileScopes.codex), "codex") ||
      profileScopeNeedsNormalization(readChild(profileScopes.claude), "claude")
    );
  }

  function profileScopeNeedsNormalization(
    value: Record<string, unknown>,
    scope: ConfigProfileScope
  ): boolean {
    if (!Array.isArray(value.profiles)) {
      return false;
    }

    return value.profiles.some((profile) => {
      if (!isRecord(profile) || !isRecord(profile.config)) {
        return false;
      }

      if (scope === "codex") {
        return (
          Object.hasOwn(profile.config, "claude") ||
          Object.hasOwn(profile.config, "listen") ||
          Object.hasOwn(profile.config, "timeouts") ||
          Object.hasOwn(profile.config, "logging")
        );
      }

      return (
        Object.hasOwn(profile.config, "primary") ||
        Object.hasOwn(profile.config, "compact") ||
        Object.hasOwn(profile.config, "listen") ||
        Object.hasOwn(profile.config, "timeouts") ||
        Object.hasOwn(profile.config, "logging")
      );
    });
  }

  function getProfileScopeState(
    config: CompactGateConfig,
    scope: ConfigProfileScope
  ): { profiles: SavedConfigProfile[]; active_profile_id: string | null } {
    const scoped = config.profile_scopes?.[scope];
    return {
      profiles: (scoped?.profiles ?? []).map(cloneProfile),
      active_profile_id: scoped?.active_profile_id ?? null
    };
  }

  function withProfileScope(
    config: CompactGateConfig,
    scope: ConfigProfileScope,
    state: SavedConfigProfileScopeState
  ): CompactGateConfig {
    const previousScopes = config.profile_scopes ?? {};
    const nextScopes: SavedConfigProfileScopes = {
      codex: cloneProfileScope(previousScopes.codex),
      claude: cloneProfileScope(previousScopes.claude)
    };
    nextScopes[scope] = cloneProfileScope(state);

    return {
      ...cloneRuntimeConfig(config),
      profiles: undefined,
      active_profile_id: nextScopes.codex?.active_profile_id ?? null,
      profile_scopes: nextScopes,
      route_url_presets: (config.route_url_presets ?? []).map(cloneRouteUrlPreset)
    };
  }

  function syncActiveProfilesFromRuntime(config: CompactGateConfig): CompactGateConfig {
    const now = new Date().toISOString();
    return syncActiveProfileScopeFromRuntime(
      syncActiveProfileScopeFromRuntime(config, "codex", now),
      "claude",
      now
    );
  }

  function syncActiveProfileScopeFromRuntime(
    config: CompactGateConfig,
    scope: ConfigProfileScope,
    updatedAt: string
  ): CompactGateConfig {
    const scopeState = getProfileScopeState(config, scope);
    const activeProfileId = scopeState.active_profile_id;
    if (!activeProfileId) {
      return withProfileScope(config, scope, {
        profiles: scopeState.profiles,
        active_profile_id: null
      });
    }

    const runtimeProfileConfig = extractScopedProfileConfig(config, scope);
    validateProfileConfig(runtimeProfileConfig, scope);
    const profiles = scopeState.profiles.map((profile) =>
      profile.id === activeProfileId
        ? {
            ...profile,
            updated_at: updatedAt,
            config: cloneProfileConfig(runtimeProfileConfig)
          }
        : cloneProfile(profile)
    );

    return withProfileScope(config, scope, {
      profiles,
      active_profile_id: activeProfileId
    });
  }

  function mergeProfileScopes(
    base: CompactGateConfig,
    patchRecord: Record<string, unknown>
  ): SavedConfigProfileScopes {
    const baseScopes = base.profile_scopes;
    const legacyActive = readActiveProfileId(patchRecord.active_profile_id, base.active_profile_id ?? null);
    const legacySource = Array.isArray(patchRecord.profiles) ? patchRecord.profiles : base.profiles;
    const legacyMigration = migrateLegacyProfiles(legacySource, legacyActive);
    const patchScopes = readChild(patchRecord.profile_scopes);

    return {
      codex: mergeProfileScopeState(
        "codex",
        baseScopes?.codex,
        readChild(patchScopes.codex),
        legacyMigration.codexProfiles,
        legacyMigration.codexActiveProfileId
      ),
      claude: mergeProfileScopeState(
        "claude",
        baseScopes?.claude,
        readChild(patchScopes.claude),
        legacyMigration.claudeProfiles,
        legacyMigration.claudeActiveProfileId
      )
    };
  }

  function mergeProfileScopeState(
    scope: ConfigProfileScope,
    baseState: SavedConfigProfileScopeState | undefined,
    patchState: Record<string, unknown>,
    legacyProfiles: SavedConfigProfile[],
    legacyActive: string | null
  ): SavedConfigProfileScopeState {
    const baseProfiles = baseState?.profiles ?? [];
    const hasPatchProfiles = Array.isArray(patchState.profiles);
    const fallbackProfiles = legacyProfiles.length > 0 && baseProfiles.length === 0 ? legacyProfiles : baseProfiles;
    const fallbackActive = legacyProfiles.length > 0 && baseProfiles.length === 0
      ? legacyActive
      : baseState?.active_profile_id ?? null;
    return {
      profiles: hasPatchProfiles ? mergeProfiles(scope, fallbackProfiles, patchState.profiles) : fallbackProfiles.map(cloneProfile),
      active_profile_id: readActiveProfileId(patchState.active_profile_id, fallbackActive)
    };
  }

  function mergeProfiles(
    scope: ConfigProfileScope,
    baseProfiles: SavedConfigProfile[],
    value: unknown
  ): SavedConfigProfile[] {
    if (!Array.isArray(value)) {
      return baseProfiles.map(cloneProfile);
    }

    return value
      .map((item) => readProfile(item, scope))
      .filter((item): item is SavedConfigProfile => item !== null);
  }

  function migrateLegacyProfiles(
    value: unknown,
    activeProfileId: string | null
  ): {
    codexProfiles: SavedConfigProfile[];
    codexActiveProfileId: string | null;
    claudeProfiles: SavedConfigProfile[];
    claudeActiveProfileId: string | null;
  } {
    if (!Array.isArray(value)) {
      return {
        codexProfiles: [],
        codexActiveProfileId: null,
        claudeProfiles: [],
        claudeActiveProfileId: null
      };
    }

    const codexProfiles = value
      .map((item) => readProfile(item, "codex"))
      .filter((item): item is SavedConfigProfile => item !== null);
    const claudeProfiles: SavedConfigProfile[] = [];
    const claudeConfigProfileIds = new Map<string, string>();
    let claudeActiveProfileId: string | null = null;

    for (const item of value) {
      const profile = readProfile(item, "claude");
      if (!profile) {
        continue;
      }

      const configKey = JSON.stringify(profile.config);
      const existingProfileId = claudeConfigProfileIds.get(configKey);
      if (existingProfileId) {
        if (profile.id === activeProfileId) {
          claudeActiveProfileId = existingProfileId;
        }
        continue;
      }

      claudeConfigProfileIds.set(configKey, profile.id);
      claudeProfiles.push(profile);
      if (profile.id === activeProfileId) {
        claudeActiveProfileId = profile.id;
      }
    }

    return {
      codexProfiles,
      codexActiveProfileId: activeProfileId && codexProfiles.some((profile) => profile.id === activeProfileId)
        ? activeProfileId
        : null,
      claudeProfiles,
      claudeActiveProfileId
    };
  }

  function readProfile(value: unknown, scope: ConfigProfileScope): SavedConfigProfile | null {
    if (!isRecord(value)) {
      return null;
    }

    const id = readString(value.id, "");
    const name = readString(value.name, "");
    if (!id || !name) {
      return null;
    }

    const config = extractScopedProfileConfig(mergeRuntimeConfig(DEFAULT_CONFIG, readChild(value.config)), scope);
    return {
      id,
      name,
      created_at: readString(value.created_at, new Date(0).toISOString()),
      updated_at: readString(value.updated_at, new Date(0).toISOString()),
      config
    };
  }

  function readActiveProfileId(value: unknown, fallback: string | null): string | null {
    if (value === null) {
      return null;
    }

    return typeof value === "string" ? value.trim() || null : fallback;
  }

  function createProfileId(name: string, isoTime: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "profile";
    return `${slug}-${Date.parse(isoTime).toString(36)}`;
  }

  return {
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
  };
}
