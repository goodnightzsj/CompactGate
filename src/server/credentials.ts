import type {
  CompactGateConfig,
  CredentialScope,
  CredentialSource
} from "../shared/types.js";

export interface ResolvedCredential {
  apiKey: string | null;
  apiKeyConfigured: boolean;
  apiKeySource: CredentialSource;
  activeApiKeyEnv: string | null;
  activeCredentialScope: CredentialScope;
}

export function resolveRouteCredential(
  route: CredentialScope,
  config: CompactGateConfig
): ResolvedCredential {
  const activeCredentialScope =
    route === "compact" && config.compact.upstream_mode === "primary" ? "primary" : route;
  const activeConfig =
    activeCredentialScope === "primary"
      ? config.primary
      : activeCredentialScope === "compact"
        ? config.compact
        : config.claude;
  const directApiKey = activeConfig.api_key.trim();

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
