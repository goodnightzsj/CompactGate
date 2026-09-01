import { isRecord } from "../shared/records.js";
import type {
  CompactGateConfig,
  CompactGateRuntimeConfig,
  SavedConfigProfile,
  SavedConfigProfileConfig,
  SavedConfigProfileScopeState
} from "../shared/types.js";

export { isRecord };

/**
 * Upper bound for `claude.long_context_bytes`, and therefore the floor for the
 * Claude route's raw-body read limit: long-context routing is decided from the
 * body size, so refusing to read a body the operator configured as routable
 * would make the threshold unreachable. Shared so the two cannot drift apart —
 * raising this alone widens what a single request can buffer in memory.
 */
export const MAX_CLAUDE_LONG_CONTEXT_BYTES = 100 * 1024 * 1024;

export class ConfigError extends Error {
  /**
   * HTTP status this error should surface as, when 400 is wrong. Clients could
   * otherwise only tell a lost write from a bad payload by regex-matching the
   * English message.
   */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ConfigError";
    this.status = status;
  }
}

export function safeHost(value: string): string {
  return URL.parse(value)?.host ?? "invalid";
}

export function isValidBaseUrl(value: string): boolean {
  const protocol = URL.parse(value)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

export function readChild(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function readNullableString(value: unknown, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return structuredClone(config);
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
  return structuredClone(config);
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
