import type {
  CompactGateConfig,
  CompactGateRuntimeConfig,
  ConfigProfileScope,
  PublicConfig,
  PublicConfigProfile,
  SavedConfigProfile,
  SavedConfigProfileConfig,
  SavedConfigProfileScopeState
} from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";
import { publicRouteUrlPreset } from "./config-route-presets.js";
import { safeHost } from "./config-url.js";

export function buildPublicConfig({
  config,
  configPath,
  lastSavedAt,
  getProfileScopeState,
  profileConfigToRuntime
}: {
  config: CompactGateConfig;
  configPath: string;
  lastSavedAt: string | null;
  getProfileScopeState: (config: CompactGateConfig, scope: ConfigProfileScope) => SavedConfigProfileScopeState;
  profileConfigToRuntime: (config: SavedConfigProfileConfig) => CompactGateRuntimeConfig;
}): PublicConfig {
  const primaryCredential = resolveRouteCredential("primary", config);
  const compactCredential = resolveRouteCredential("compact", config);
  const claudePrimaryCredential = resolveRouteCredential("claude_primary", config);
  const claudeCompactCredential = resolveRouteCredential("claude_compact", config);
  const codexProfileScope = publicProfileScope(
    config,
    "codex",
    getProfileScopeState,
    profileConfigToRuntime
  );
  const claudeProfileScope = publicProfileScope(
    config,
    "claude",
    getProfileScopeState,
    profileConfigToRuntime
  );

  return {
    primary: {
      base_url: config.primary.base_url,
      api_key_env: config.primary.api_key_env,
      host: safeHost(config.primary.base_url),
      stored_api_key: directApiKeyConfigured(config.primary.api_key),
      api_key_configured: primaryCredential.apiKeyConfigured,
      api_key_source: primaryCredential.apiKeySource,
      active_api_key_env: primaryCredential.activeApiKeyEnv,
      active_credential_scope: primaryCredential.activeCredentialScope,
      model_override: config.primary.model_override ?? "",
      reasoning_effort: config.primary.reasoning_effort
    },
    compact: {
      base_url: config.compact.base_url,
      api_key_env: config.compact.api_key_env,
      host: safeHost(config.compact.base_url),
      stored_api_key: directApiKeyConfigured(config.compact.api_key),
      api_key_configured: compactCredential.apiKeyConfigured,
      api_key_source: compactCredential.apiKeySource,
      active_api_key_env: compactCredential.activeApiKeyEnv,
      upstream_mode: config.compact.upstream_mode,
      model_mode: config.compact.model_mode,
      model_template: config.compact.model_template,
      model_override: config.compact.model_override,
      active_credential_scope: compactCredential.activeCredentialScope
    },
    claude: {
      primary: {
        base_url: config.claude.primary.base_url,
        api_key_env: config.claude.primary.api_key_env,
        host: safeHost(config.claude.primary.base_url),
        stored_api_key: directApiKeyConfigured(config.claude.primary.api_key),
        api_key_configured: claudePrimaryCredential.apiKeyConfigured,
        api_key_source: claudePrimaryCredential.apiKeySource,
        active_api_key_env: claudePrimaryCredential.activeApiKeyEnv,
        active_credential_scope: claudePrimaryCredential.activeCredentialScope,
        model_override: config.claude.primary.model_override
      },
      compact: {
        base_url: config.claude.compact.base_url,
        api_key_env: config.claude.compact.api_key_env,
        host: safeHost(config.claude.compact.base_url),
        stored_api_key: directApiKeyConfigured(config.claude.compact.api_key),
        api_key_configured: claudeCompactCredential.apiKeyConfigured,
        api_key_source: claudeCompactCredential.apiKeySource,
        active_api_key_env: claudeCompactCredential.activeApiKeyEnv,
        active_credential_scope: claudeCompactCredential.activeCredentialScope,
        upstream_mode: config.claude.compact.upstream_mode,
        model_override: config.claude.compact.model_override
      },
      model_map: { ...config.claude.model_map }
    },
    listen: config.listen,
    timeouts: config.timeouts,
    logging: config.logging,
    primary_failover: { ...config.primary_failover },
    profiles: codexProfileScope.profiles,
    active_profile_id: codexProfileScope.active_profile_id,
    profile_scopes: {
      codex: codexProfileScope,
      claude: claudeProfileScope
    },
    route_url_presets: (config.route_url_presets ?? []).map(publicRouteUrlPreset),
    config_path: configPath,
    last_saved_at: lastSavedAt
  };
}

function publicProfileScope(
  config: CompactGateConfig,
  scope: ConfigProfileScope,
  getProfileScopeState: (config: CompactGateConfig, scope: ConfigProfileScope) => SavedConfigProfileScopeState,
  profileConfigToRuntime: (config: SavedConfigProfileConfig) => CompactGateRuntimeConfig
): PublicConfig["profile_scopes"]["codex"] {
  const state = getProfileScopeState(config, scope);
  const profiles = state.profiles ?? [];
  return {
    profiles: profiles.map((profile) => toPublicProfile(profile, scope, profileConfigToRuntime)),
    active_profile_id: state.active_profile_id ?? null
  };
}

function toPublicProfile(
  profile: SavedConfigProfile,
  scope: ConfigProfileScope,
  profileConfigToRuntime: (config: SavedConfigProfileConfig) => CompactGateRuntimeConfig
): PublicConfigProfile {
  const runtime = profileConfigToRuntime(profile.config);
  const codexProfile = scope === "codex";
  const storedApiKeys = codexProfile
    ? [runtime.primary.api_key, runtime.compact.api_key]
    : [runtime.claude.primary.api_key, runtime.claude.compact.api_key];

  return {
    id: profile.id,
    scope,
    name: profile.name,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    primary_base_url: codexProfile ? runtime.primary.base_url : null,
    compact_base_url: codexProfile ? runtime.compact.base_url : null,
    claude_primary_base_url: codexProfile ? null : runtime.claude.primary.base_url,
    claude_compact_base_url: codexProfile ? null : runtime.claude.compact.base_url,
    primary_host: codexProfile ? safeHost(runtime.primary.base_url) : null,
    compact_host: codexProfile ? safeHost(runtime.compact.base_url) : null,
    claude_primary_host: codexProfile ? null : safeHost(runtime.claude.primary.base_url),
    claude_compact_host: codexProfile ? null : safeHost(runtime.claude.compact.base_url),
    claude_primary_model_override: codexProfile ? null : runtime.claude.primary.model_override,
    claude_compact_model_override: codexProfile ? null : runtime.claude.compact.model_override,
    claude_model_map: codexProfile ? null : { ...runtime.claude.model_map },
    compact_upstream_mode: codexProfile ? runtime.compact.upstream_mode : null,
    claude_compact_upstream_mode: codexProfile ? null : runtime.claude.compact.upstream_mode,
    stored_api_key_count: storedApiKeys.filter(directApiKeyConfigured).length
  };
}

function directApiKeyConfigured(value: string): boolean {
  return value.trim().length > 0;
}
