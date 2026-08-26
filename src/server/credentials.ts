import type {
  CompactGateConfig,
  CredentialScope,
  CredentialSource,
  UpstreamApiKey,
  UpstreamConfig
} from "../shared/types.js";

export interface ResolvedCredential {
  apiKey: string | null;
  apiKeyConfigured: boolean;
  apiKeySource: CredentialSource;
  activeApiKeyEnv: string | null;
  activeCredentialScope: CredentialScope;
}

/**
 * The schedulable entries of a route's key pool. An absent or empty pool is the
 * single `api_key` — never materialized into an entry, so a legacy file cannot
 * lose its stored key to an empty array.
 */
export function enabledApiKeyPool(route: UpstreamConfig): UpstreamApiKey[] {
  return (route.api_keys ?? []).filter(
    (key) => key.enabled && key.api_key.trim().length > 0
  );
}

export function resolveRouteCredential(
  route: CredentialScope,
  config: CompactGateConfig
): ResolvedCredential {
  const activeCredentialScope =
    route === "compact" && config.compact.upstream_mode === "primary"
      ? "primary"
      : route === "claude_compact" && config.claude.compact.upstream_mode === "primary"
        ? "claude_primary"
        : route;
  const activeConfig = configForCredentialScope(activeCredentialScope, config);
  // Outside the failover scheduler (compact routing, health, model probes) a
  // pool is served by its first enabled key. Per-request rotation lives in the
  // candidate list, not here — this function must stay pure: the failover
  // signatures hash its output on every preview.
  const poolKey = enabledApiKeyPool(activeConfig)[0];
  const directApiKey = poolKey ? poolKey.api_key.trim() : activeConfig.api_key.trim();

  if (directApiKey.length > 0) {
    return {
      apiKey: directApiKey,
      apiKeyConfigured: true,
      apiKeySource: "config",
      activeApiKeyEnv: null,
      activeCredentialScope
    };
  }

  const envName = activeConfig.api_key_env.trim();
  const envApiKey = envName.length > 0 ? process.env[envName] : undefined;
  if (typeof envApiKey === "string" && envApiKey.length > 0) {
    return {
      apiKey: envApiKey,
      apiKeyConfigured: true,
      apiKeySource: "env",
      activeApiKeyEnv: envName,
      activeCredentialScope
    };
  }

  return {
    apiKey: null,
    apiKeyConfigured: false,
    apiKeySource: "missing",
    activeApiKeyEnv: envName.length > 0 ? envName : null,
    activeCredentialScope
  };
}

function configForCredentialScope(
  scope: CredentialScope,
  config: CompactGateConfig
): UpstreamConfig {
  switch (scope) {
    case "primary":
      return config.primary;
    case "compact":
      return config.compact;
    case "claude_compact":
      return config.claude.compact;
    case "claude":
    case "claude_primary":
      return config.claude.primary;
  }
}
