import type {
  CompactGateConfig,
  CredentialScope,
  HealthResponse,
  PublicCredentialState,
  UpstreamConfig
} from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";
import type { RequestLogger } from "./logger.js";
import { CODEX_PROTOCOL_LOG_LIMIT } from "./codex-version.js";
import type { CodexVersionMonitor } from "./codex-version.js";
import type { ClientIdentityStore } from "./client-identity-store.js";
import { isValidBaseUrl } from "./config-internals.js";

export function healthForConfig(
  config: CompactGateConfig,
  logger: RequestLogger,
  codexVersionMonitor: CodexVersionMonitor,
  clientIdentity: ClientIdentityStore
): HealthResponse {
  const routeState = (
    scope: CredentialScope,
    upstream: UpstreamConfig
  ): { status: "configured" | "invalid"; base_url: string; host: string | null } & PublicCredentialState => {
    const credential = resolveRouteCredential(scope, config);
    return {
      status: isValidBaseUrl(upstream.base_url) ? "configured" : "invalid",
      base_url: upstream.base_url,
      host: hostOrNull(upstream.base_url),
      api_key_env: upstream.api_key_env,
      stored_api_key: upstream.api_key.trim().length > 0,
      stored_api_key_tail: upstream.api_key.trim().slice(-4),
      api_key_configured: credential.apiKeyConfigured,
      api_key_source: credential.apiKeySource,
      active_api_key_env: credential.activeApiKeyEnv,
      active_credential_scope: credential.activeCredentialScope
    };
  };

  return {
    status: "ok",
    time: new Date().toISOString(),
    listen: config.listen,
    logger: logger.getPersistenceHealth(),
    codex: codexVersionMonitor.snapshot(
      logger.recentLogs({ route: "compact", limit: CODEX_PROTOCOL_LOG_LIMIT })
    ),
    client_identity: clientIdentity.status(),
    primary: routeState("primary", config.primary),
    compact: routeState("compact", config.compact),
    claude: {
      primary: routeState("claude_primary", config.claude.primary),
      compact: routeState("claude_compact", config.claude.compact)
    }
  };
}

export function hostOrNull(value: string): string | null {
  return URL.parse(value)?.host ?? null;
}
