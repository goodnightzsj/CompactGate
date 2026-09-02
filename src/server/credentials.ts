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
 * Identity of the route's own `api_key` once it takes part in the pool. Reserved:
 * `validateApiKeys` rejects an explicit entry claiming it, so the composite
 * health keys (`profileId#keyId`) can never collide with a stored entry's.
 */
export const DIRECT_API_KEY_ID = "__direct__";

/**
 * The schedulable entries of a route's key pool, the direct `api_key` first.
 *
 * The direct key is a pool member, not a fallback the pool shadows: adding a
 * second credential in the Studio used to *replace* the one already configured,
 * because every scheduler read the explicit pool and stopped there. It leads
 * because `fill_first` means "burn the first before the next", and the key that
 * was already carrying the route is the one to burn first.
 *
 * An absent or empty `api_keys` is still just the single key, and it stays
 * unmaterialized in the file so a legacy config cannot lose its stored key.
 */
export function enabledApiKeyPool(route: UpstreamConfig): UpstreamApiKey[] {
  const direct = route.api_key.trim();
  const stored = (route.api_keys ?? []).filter(
    (key) => key.enabled && key.api_key.trim().length > 0
  );
  return direct.length > 0
    ? [{ id: DIRECT_API_KEY_ID, label: "", api_key: direct, enabled: true }, ...stored]
    : stored;
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
  // pool is served by its first enabled key, which is the direct `api_key`
  // whenever one is configured. Per-request rotation lives in the candidate
  // list, not here — this function must stay pure: the failover signatures hash
  // its output on every preview.
  const poolKey = enabledApiKeyPool(activeConfig)[0];
  const directApiKey = poolKey ? poolKey.api_key.trim() : "";

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
