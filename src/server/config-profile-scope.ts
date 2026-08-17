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
  cloneRuntimeConfig,
  isRecord,
  readChild,
  readString
} from "./config-internals.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { cloneRouteUrlPreset } from "./config-route-presets.js";
import {
  mergeRuntimeConfig,
  validateRuntimeConfig
} from "./config-runtime.js";

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
      model_map: { ...runtime.claude.model_map },
      scene_map: structuredClone(runtime.claude.scene_map),
      long_context_bytes: runtime.claude.long_context_bytes
    }
  };
}

export function mergeProfileScopes(
  base: CompactGateConfig,
  patchRecord: Record<string, unknown>
): SavedConfigProfileScopes {
  const baseScopes = base.profile_scopes;
  const patchScopes = readChild(patchRecord.profile_scopes);

  return {
    codex: mergeProfileScopeState("codex", baseScopes?.codex, readChild(patchScopes.codex)),
    claude: mergeProfileScopeState("claude", baseScopes?.claude, readChild(patchScopes.claude))
  };
}

function mergeProfileScopeState(
  scope: ConfigProfileScope,
  baseState: SavedConfigProfileScopeState | undefined,
  patchState: Record<string, unknown>
): SavedConfigProfileScopeState {
  const baseProfiles = baseState?.profiles ?? [];
  return {
    profiles: Array.isArray(patchState.profiles)
      ? mergeProfiles(scope, baseProfiles, patchState.profiles)
      : baseProfiles.map(cloneProfile),
    active_profile_id: readActiveProfileId(
      patchState.active_profile_id,
      baseState?.active_profile_id ?? null
    )
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

function readProfile(
  value: unknown,
  scope: ConfigProfileScope
): SavedConfigProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value.id, "");
  const name = readString(value.name, "");
  if (!id || !name) {
    return null;
  }

  const config = extractScopedProfileConfig(
    mergeRuntimeConfig(DEFAULT_CONFIG, readChild(value.config)),
    scope
  );
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
      model_map: { ...profileRuntime.claude.model_map },
      scene_map: structuredClone(profileRuntime.claude.scene_map),
      long_context_bytes: profileRuntime.claude.long_context_bytes
    }
  };
}

export function profileConfigToRuntime(config: SavedConfigProfileConfig): CompactGateRuntimeConfig {
  return mergeRuntimeConfig(DEFAULT_CONFIG, config);
}

export function validateProfileConfig(config: SavedConfigProfileConfig, scope: ConfigProfileScope): void {
  validateRuntimeConfig(profileConfigToRuntime(extractScopedProfileConfig(profileConfigToRuntime(config), scope)));
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
