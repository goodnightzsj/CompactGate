import type {
  CompactGateConfig,
  CompactGateRuntimeConfig,
  SavedConfigProfile,
  SavedConfigProfileConfig,
  SavedConfigProfileScopeState
} from "../shared/types.js";

export function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}

export function cloneRuntimeConfig(config: CompactGateRuntimeConfig): CompactGateRuntimeConfig {
  return JSON.parse(JSON.stringify({
    listen: config.listen,
    primary: config.primary,
    compact: config.compact,
    claude: config.claude,
    timeouts: config.timeouts,
    logging: config.logging,
    primary_failover: config.primary_failover
  })) as CompactGateRuntimeConfig;
}

export function cloneProfileConfig(config: SavedConfigProfileConfig): SavedConfigProfileConfig {
  return JSON.parse(JSON.stringify(config)) as SavedConfigProfileConfig;
}

export function cloneProfileScope(state: SavedConfigProfileScopeState | undefined): SavedConfigProfileScopeState {
  return {
    profiles: (state?.profiles ?? []).map(cloneProfile),
    active_profile_id: state?.active_profile_id ?? null
  };
}

export function cloneProfile(profile: SavedConfigProfile): SavedConfigProfile {
  return {
    id: profile.id,
    name: profile.name,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    config: cloneProfileConfig(profile.config)
  };
}
