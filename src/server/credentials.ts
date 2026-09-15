import type {
  CompactGateConfig,
  CredentialScope,
  CredentialSource,
  UpstreamApiKey,
  UpstreamConfig
} from "../shared/types.js";
import { DIRECT_API_KEY_ID } from "../shared/api-key-priority.js";
export { DIRECT_API_KEY_ID } from "../shared/api-key-priority.js";

export interface ResolvedCredential {
  apiKey: string | null;
  apiKeyConfigured: boolean;
  apiKeySource: CredentialSource;
  activeApiKeyEnv: string | null;
  activeCredentialScope: CredentialScope;
  oauthAccountId?: string;
}

/**
 * The schedulable entries, highest priority first. Ties keep the direct
 * `api_key` first, then the configured pool order.
 *
 * The direct key is a pool member, not a fallback the pool shadows: adding a
 * second credential in the Studio used to *replace* the one already configured,
 * because every scheduler read the explicit pool and stopped there. It leads
 * within the default priority because `fill_first` means "burn the first
 * before the next". Changing priority never changes a key's stable identity.
 *
 * An absent or empty `api_keys` is still just the single key, and it stays
 * unmaterialized in the file so a legacy config cannot lose its stored key.
 */
export function enabledApiKeyPool(route: UpstreamConfig): UpstreamApiKey[] {
  if (route.oauth_account_id) return [];
  const direct = route.api_key.trim();
  const stored = (route.api_keys ?? []).filter(
    (key) => key.enabled && key.api_key.trim().length > 0
  );
  const entries = direct.length > 0
    ? [{ id: DIRECT_API_KEY_ID, label: "", api_key: direct, enabled: true, priority: route.api_key_priority ?? 0 }, ...stored]
    : stored;
  return entries.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
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
  if (activeConfig.oauth_account_id) {
    return {
      apiKey: null, apiKeyConfigured: true, apiKeySource: "oauth",
      activeApiKeyEnv: null, activeCredentialScope,
      oauthAccountId: activeConfig.oauth_account_id
    };
  }
  // Outside the failover scheduler (compact routing, health, model probes) a
  // pool is served by its highest-priority enabled key (direct wins ties).
  // Per-request rotation lives in the candidate
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
