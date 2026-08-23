import type {
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig,
  PublicConfigProfile,
  PublicUpstreamConfig,
  SavedConfigProfile,
  UpstreamConfig
} from "../shared/types.js";
import {
  getProfileScopeState,
  profileConfigToRuntime
} from "./config-profile-scope.js";
import { resolveRouteCredential, type ResolvedCredential } from "./credentials.js";
import { publicRouteUrlPreset } from "./config-route-presets.js";
import { safeHost } from "./config-internals.js";

export function buildPublicConfig({
  config,
  configPath,
  lastSavedAt,
  revision
}: {
  config: CompactGateConfig;
  configPath: string;
  lastSavedAt: string | null;
  revision: string;
}): PublicConfig {
  const codexProfileScope = publicProfileScope(config, "codex");
  const claudeProfileScope = publicProfileScope(config, "claude");

  return {
    primary: {
      ...publicUpstream(config.primary, resolveRouteCredential("primary", config)),
      model_override: config.primary.model_override ?? "",
      reasoning_effort: config.primary.reasoning_effort,
      state_domain_id: config.primary.state_domain_id
    },
    compact: {
      ...publicUpstream(config.compact, resolveRouteCredential("compact", config)),
      upstream_mode: config.compact.upstream_mode,
      model_mode: config.compact.model_mode,
      model_template: config.compact.model_template,
      model_override: config.compact.model_override
    },
    claude: {
      primary: {
        ...publicUpstream(config.claude.primary, resolveRouteCredential("claude_primary", config)),
        model_override: config.claude.primary.model_override
      },
      compact: {
        ...publicUpstream(config.claude.compact, resolveRouteCredential("claude_compact", config)),
        upstream_mode: config.claude.compact.upstream_mode,
        model_override: config.claude.compact.model_override
      },
      model_map: { ...config.claude.model_map },
      scene_map: structuredClone(config.claude.scene_map),
      long_context_bytes: config.claude.long_context_bytes
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
    last_saved_at: lastSavedAt,
    revision
  };
}

function publicProfileScope(
  config: CompactGateConfig,
  scope: ConfigProfileScope
): PublicConfig["profile_scopes"]["codex"] {
  const state = getProfileScopeState(config, scope);
  return {
    profiles: state.profiles.map((profile) => toPublicProfile(profile, scope)),
    active_profile_id: state.active_profile_id
  };
}

function toPublicProfile(
  profile: SavedConfigProfile,
  scope: ConfigProfileScope
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
    primary_state_domain_id: codexProfile ? runtime.primary.state_domain_id : null,
    // Codex profiles override the client's reasoning effort, so the card has to
    // be able to show which one this profile pins.
    primary_reasoning_effort: codexProfile ? runtime.primary.reasoning_effort : null,
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
    primary_upstream_protocol: codexProfile ? runtime.primary.upstream_protocol : null,
    compact_upstream_protocol: codexProfile ? runtime.compact.upstream_protocol : null,
    claude_primary_upstream_protocol: codexProfile ? null : runtime.claude.primary.upstream_protocol,
    claude_compact_upstream_protocol: codexProfile ? null : runtime.claude.compact.upstream_protocol,
    stored_api_key_count: storedApiKeys.filter(directApiKeyConfigured).length
  };
}

function directApiKeyConfigured(value: string): boolean {
  return value.trim().length > 0;
}

function publicUpstream(
  upstream: UpstreamConfig,
  credential: ResolvedCredential
): Omit<PublicUpstreamConfig, "model_override"> {
  const proxy = URL.parse(upstream.proxy_url);
  return {
    base_url: upstream.base_url,
    api_key_env: upstream.api_key_env,
    host: safeHost(upstream.base_url),
    extra_header_names: Object.keys(upstream.extra_headers).sort(),
    proxy_configured: upstream.proxy_url.trim().length > 0,
    proxy_host: proxy?.host ?? null,
    proxy_authenticated: Boolean(proxy && (proxy.username || proxy.password)),
    upstream_protocol: upstream.upstream_protocol,
    stored_api_key: directApiKeyConfigured(upstream.api_key),
    api_key_configured: credential.apiKeyConfigured,
    api_key_source: credential.apiKeySource,
    active_api_key_env: credential.activeApiKeyEnv,
    active_credential_scope: credential.activeCredentialScope
  };
}
