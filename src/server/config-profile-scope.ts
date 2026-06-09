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
import {
  mergeProfileScopes as mergeProfileScopesWithRuntime,
  shouldPersistProfileNormalization
} from "./config-profile-scope-merge.js";
import { cloneRouteUrlPreset } from "./config-route-presets.js";
import {
  mergeRuntimeConfig,
  validateRuntimeConfig
} from "./config-runtime.js";

export function mergeRuntimeForProfileScope(
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

export function createScopedProfileConfig(
  current: CompactGateRuntimeConfig,
  patch: unknown,
  scope: ConfigProfileScope
): SavedConfigProfileConfig {
  return extractScopedProfileConfig(mergeRuntimeConfig(current, patch), scope);
}

export function updateScopedProfileConfig(
  current: SavedConfigProfileConfig,
  patch: unknown,
  scope: ConfigProfileScope
): SavedConfigProfileConfig {
  return extractScopedProfileConfig(mergeRuntimeConfig(profileConfigToRuntime(current), patch), scope);
}

export function extractScopedProfileConfig(
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

export function profileConfigToRuntime(config: SavedConfigProfileConfig): CompactGateRuntimeConfig {
  return mergeRuntimeConfig(DEFAULT_CONFIG, config);
}

export function validateProfileConfig(config: SavedConfigProfileConfig, scope: ConfigProfileScope): void {
  validateRuntimeConfig(profileConfigToRuntime(extractScopedProfileConfig(profileConfigToRuntime(config), scope)));
}

export { shouldPersistProfileNormalization };

export function mergeProfileScopes(
  base: CompactGateConfig,
  patchRecord: Record<string, unknown>
): SavedConfigProfileScopes {
  return mergeProfileScopesWithRuntime(base, patchRecord, {
    mergeRuntimeConfig,
    extractScopedProfileConfig
  });
}

export function getProfileScopeState(
  config: CompactGateConfig,
  scope: ConfigProfileScope
): { profiles: SavedConfigProfile[]; active_profile_id: string | null } {
  const scoped = config.profile_scopes?.[scope];
  return {
    profiles: (scoped?.profiles ?? []).map(cloneProfile),
    active_profile_id: scoped?.active_profile_id ?? null
  };
}

export function withProfileScope(
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

export function syncActiveProfilesFromRuntime(config: CompactGateConfig): CompactGateConfig {
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

export function createProfileId(name: string, isoTime: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "profile";
  return `${slug}-${Date.parse(isoTime).toString(36)}`;
}
