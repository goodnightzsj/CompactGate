import type { CompactGateConfig, HealthResponse } from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";
import type { RequestLogger } from "./logger.js";
import { CODEX_PROTOCOL_LOG_LIMIT } from "./codex-version.js";
import type { CodexVersionMonitor } from "./codex-version.js";

export function healthForConfig(
  config: CompactGateConfig,
  logger: RequestLogger,
  codexVersionMonitor: CodexVersionMonitor
): HealthResponse {
  const primaryCredential = resolveRouteCredential("primary", config);
  const compactCredential = resolveRouteCredential("compact", config);
  const claudePrimaryCredential = resolveRouteCredential("claude_primary", config);
  const claudeCompactCredential = resolveRouteCredential("claude_compact", config);

  return {
    status: "ok",
    time: new Date().toISOString(),
    listen: config.listen,
    logger: logger.getPersistenceHealth(),
    codex: codexVersionMonitor.snapshot(
      logger.page({ route: "compact", limit: CODEX_PROTOCOL_LOG_LIMIT, offset: 0 }).logs
    ),
    primary: {
      status: statusForBaseUrl(config.primary.base_url),
      base_url: config.primary.base_url,
      host: hostOrNull(config.primary.base_url),
      api_key_env: config.primary.api_key_env,
      stored_api_key: config.primary.api_key.trim().length > 0,
      api_key_configured: primaryCredential.apiKeyConfigured,
      api_key_source: primaryCredential.apiKeySource,
      active_api_key_env: primaryCredential.activeApiKeyEnv,
      active_credential_scope: primaryCredential.activeCredentialScope
    },
    compact: {
      status: statusForBaseUrl(config.compact.base_url),
      base_url: config.compact.base_url,
      host: hostOrNull(config.compact.base_url),
      api_key_env: config.compact.api_key_env,
      stored_api_key: config.compact.api_key.trim().length > 0,
      api_key_configured: compactCredential.apiKeyConfigured,
      api_key_source: compactCredential.apiKeySource,
      active_api_key_env: compactCredential.activeApiKeyEnv,
      active_credential_scope: compactCredential.activeCredentialScope
    },
    claude: {
      primary: {
        status: statusForBaseUrl(config.claude.primary.base_url),
        base_url: config.claude.primary.base_url,
        host: hostOrNull(config.claude.primary.base_url),
        api_key_env: config.claude.primary.api_key_env,
        stored_api_key: config.claude.primary.api_key.trim().length > 0,
        api_key_configured: claudePrimaryCredential.apiKeyConfigured,
        api_key_source: claudePrimaryCredential.apiKeySource,
        active_api_key_env: claudePrimaryCredential.activeApiKeyEnv,
        active_credential_scope: claudePrimaryCredential.activeCredentialScope
      },
      compact: {
        status: statusForBaseUrl(config.claude.compact.base_url),
        base_url: config.claude.compact.base_url,
        host: hostOrNull(config.claude.compact.base_url),
        api_key_env: config.claude.compact.api_key_env,
        stored_api_key: config.claude.compact.api_key.trim().length > 0,
        api_key_configured: claudeCompactCredential.apiKeyConfigured,
        api_key_source: claudeCompactCredential.apiKeySource,
        active_api_key_env: claudeCompactCredential.activeApiKeyEnv,
        active_credential_scope: claudeCompactCredential.activeCredentialScope
      }
    }
  };
}

export function hostOrNull(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function statusForBaseUrl(value: string): "configured" | "invalid" {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? "configured" : "invalid";
  } catch {
    return "invalid";
  }
}
