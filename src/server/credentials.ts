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
    route === "compact" && config.compact.upstream_mode === "primary"
      ? "primary"
      : route === "claude_compact" && config.claude.compact.upstream_mode === "primary"
        ? "claude_primary"
        : route;
  const activeConfig = configForCredentialScope(activeCredentialScope, config);
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

function configForCredentialScope(
  scope: CredentialScope,
  config: CompactGateConfig
): CompactGateConfig["primary"] {
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
