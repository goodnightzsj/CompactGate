import type {
  ClaudeModelMap,
  CompactGateRuntimeConfig,
  CompactModelMode,
  CompactUpstreamMode
} from "../shared/types.js";
import { CLAUDE_MODEL_MAP_ROLES, emptyClaudeModelMap } from "./config-defaults.js";
import { ConfigError } from "./config-error.js";
import {
  isRecord,
  readBoolean,
  readChild,
  readNumber,
  readSensitiveString,
  readString
} from "./config-readers.js";

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function validateRuntimeConfig(config: CompactGateRuntimeConfig): void {
  validateListen(config.listen);
  validateBaseUrl(config.primary.base_url, "primary.base_url");
  validateBaseUrl(config.compact.base_url, "compact.base_url");
  validateBaseUrl(config.claude.primary.base_url, "claude.primary.base_url");
  validateBaseUrl(config.claude.compact.base_url, "claude.compact.base_url");
  validateEnvName(config.primary.api_key_env, "primary.api_key_env");
  validateEnvName(config.compact.api_key_env, "compact.api_key_env");
  validateEnvName(config.claude.primary.api_key_env, "claude.primary.api_key_env");
  validateEnvName(config.claude.compact.api_key_env, "claude.compact.api_key_env");
  validateOptionalModelName(config.claude.primary.model_override, "claude.primary.model_override");
  validateOptionalModelName(config.claude.compact.model_override, "claude.compact.model_override");
  validateClaudeModelMap(config.claude.model_map);
  validateUpstreamMode(config.compact.upstream_mode);
  validateUpstreamMode(config.claude.compact.upstream_mode);
  validateModelMode(config.compact.model_mode);

  if (!config.compact.model_template.includes("{model}")) {
    throw new ConfigError("compact.model_template must include {model}.");
  }

  if (
    config.compact.model_mode === "custom" &&
    config.compact.model_override.trim().length === 0
  ) {
    throw new ConfigError("compact.model_override is required in custom mode.");
  }

  validateTimeoutMs(config.timeouts.primary_ms, "timeouts.primary_ms");
  validateTimeoutMs(config.timeouts.compact_ms, "timeouts.compact_ms");
  validateTimeoutMs(config.timeouts.claude_ms, "timeouts.claude_ms");
  validatePrimaryFailover(config.primary_failover);

  if (
    !Number.isInteger(config.logging.keep_recent) ||
    config.logging.keep_recent < 1 ||
    config.logging.keep_recent > 2_000
  ) {
    throw new ConfigError("logging.keep_recent must be between 1 and 2000.");
  }
}

export function parseListenAddress(listen: string): { host: string; port: number } {
  const index = listen.lastIndexOf(":");
  if (index <= 0) {
    throw new ConfigError("listen must be formatted as host:port.");
  }

  const host = listen.slice(0, index);
  const portText = listen.slice(index + 1);
  const port = /^\d+$/.test(portText) ? Number(portText) : Number.NaN;

  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new ConfigError("listen must contain a valid host and port.");
  }

  return { host, port };
}

export function validateBaseUrl(value: string, field: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
  } catch {
    throw new ConfigError(`${field} must be a valid http or https URL.`);
  }
}

export function mergeRuntimeConfig(
  base: CompactGateRuntimeConfig,
  patch: unknown
): CompactGateRuntimeConfig {
  const patchRecord = isRecord(patch) ? patch : {};
  const compactPatch = readChild(patchRecord.compact);

  return {
    listen: readString(patchRecord.listen, base.listen),
    primary: mergeUpstreamConfig(base.primary, readChild(patchRecord.primary)),
    compact: {
      base_url: readString(compactPatch.base_url, base.compact.base_url),
      api_key: readSensitiveString(compactPatch.api_key, base.compact.api_key),
      api_key_env: readString(compactPatch.api_key_env, base.compact.api_key_env),
      upstream_mode: readString(
        compactPatch.upstream_mode,
        base.compact.upstream_mode
      ) as CompactUpstreamMode,
      model_mode: readString(
        compactPatch.model_mode,
        base.compact.model_mode
      ) as CompactModelMode,
      model_template: readString(
        compactPatch.model_template,
        base.compact.model_template
      ),
      model_override: readString(
        compactPatch.model_override,
        base.compact.model_override
      )
    },
    claude: mergeClaudeConfig(base.claude, readChild(patchRecord.claude)),
    timeouts: {
      primary_ms: readNumber(readChild(patchRecord.timeouts).primary_ms, base.timeouts.primary_ms),
      compact_ms: readNumber(readChild(patchRecord.timeouts).compact_ms, base.timeouts.compact_ms),
      claude_ms: readNumber(readChild(patchRecord.timeouts).claude_ms, base.timeouts.claude_ms)
    },
    logging: {
      redact_body: readBoolean(readChild(patchRecord.logging).redact_body, base.logging.redact_body),
      persist_body: readBoolean(readChild(patchRecord.logging).persist_body, base.logging.persist_body),
      keep_recent: readNumber(readChild(patchRecord.logging).keep_recent, base.logging.keep_recent)
    },
    primary_failover: {
      auto_schedule: readBoolean(
        readChild(patchRecord.primary_failover).auto_schedule,
        base.primary_failover.auto_schedule
      )
    }
  };
}

function validateListen(listen: string): void {
  parseListenAddress(listen);
}

function validateTimeoutMs(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_NODE_TIMER_DELAY_MS) {
    throw new ConfigError(`${field} must be between 1 and ${MAX_NODE_TIMER_DELAY_MS}.`);
  }
}

function validatePrimaryFailover(value: CompactGateRuntimeConfig["primary_failover"]): void {
  if (typeof value.auto_schedule !== "boolean") {
    throw new ConfigError("primary_failover.auto_schedule must be a boolean.");
  }
}

function validateEnvName(value: string, field: string): void {
  if (value.trim().length === 0) {
    return;
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new ConfigError(`${field} must be an environment variable name.`);
  }
}

function validateModelMode(value: string): asserts value is CompactModelMode {
  if (value !== "linked" && value !== "custom") {
    throw new ConfigError("compact.model_mode must be linked or custom.");
  }
}

function validateOptionalModelName(value: string, field: string): void {
  if (value.trim().length > 256) {
    throw new ConfigError(`${field} must be 256 characters or fewer.`);
  }
}

function validateClaudeModelMap(modelMap: ClaudeModelMap): void {
  for (const role of CLAUDE_MODEL_MAP_ROLES) {
    validateOptionalModelName(modelMap[role] ?? "", `claude.model_map.${role}`);
  }
}

function validateUpstreamMode(value: string): asserts value is CompactUpstreamMode {
  if (value !== "split" && value !== "primary") {
    throw new ConfigError("compact.upstream_mode must be split or primary.");
  }
}

function mergeUpstreamConfig(
  base: CompactGateRuntimeConfig["primary"],
  patch: Record<string, unknown>
): CompactGateRuntimeConfig["primary"] {
  return {
    base_url: readString(patch.base_url, base.base_url),
    api_key: readSensitiveString(patch.api_key, base.api_key),
    api_key_env: readString(patch.api_key_env, base.api_key_env)
  };
}

function mergeClaudeConfig(
  base: CompactGateRuntimeConfig["claude"],
  patch: Record<string, unknown>
): CompactGateRuntimeConfig["claude"] {
  const primaryPatch = readChild(patch.primary);
  const compactPatch = readChild(patch.compact);
  const modelMapPatch = readChild(patch.model_map);
  const hasModelMapPatch = Object.keys(modelMapPatch).length > 0;

  if (Object.keys(primaryPatch).length > 0 || Object.keys(compactPatch).length > 0) {
    const modelMap = mergeClaudeModelMap(base.model_map, modelMapPatch);
    if (!hasModelMapPatch && typeof primaryPatch.model_override === "string") {
      modelMap.default = primaryPatch.model_override.trim();
    }
    return {
      primary: {
        ...mergeClaudePrimaryConfig(base.primary, primaryPatch),
        model_override: modelMap.default
      },
      compact: mergeClaudeCompactConfig(base.compact, compactPatch),
      model_map: modelMap
    };
  }

  if (Object.hasOwn(patch, "base_url") || Object.hasOwn(patch, "api_key") || Object.hasOwn(patch, "api_key_env")) {
    const legacy = mergeUpstreamConfig(base.primary, patch);
    const modelMap = mergeClaudeModelMap(base.model_map, modelMapPatch);
    return {
      primary: {
        ...legacy,
        model_override: modelMap.default
      },
      compact: {
        ...legacy,
        upstream_mode: base.compact.upstream_mode,
        model_override: base.compact.model_override
      },
      model_map: modelMap
    };
  }

  if (hasModelMapPatch) {
    const modelMap = mergeClaudeModelMap(base.model_map, modelMapPatch);
    return {
      primary: {
        ...base.primary,
        model_override: modelMap.default
      },
      compact: { ...base.compact },
      model_map: modelMap
    };
  }

  return {
    primary: {
      ...base.primary,
      model_override: base.model_map.default
    },
    compact: { ...base.compact },
    model_map: { ...base.model_map }
  };
}

function mergeClaudeModelMap(base: ClaudeModelMap, patch: Record<string, unknown>): ClaudeModelMap {
  const next: ClaudeModelMap = {
    ...emptyClaudeModelMap(),
    ...base
  };

  for (const role of CLAUDE_MODEL_MAP_ROLES) {
    next[role] = readString(patch[role], next[role]);
  }

  return next;
}

function mergeClaudePrimaryConfig(
  base: CompactGateRuntimeConfig["claude"]["primary"],
  patch: Record<string, unknown>
): CompactGateRuntimeConfig["claude"]["primary"] {
  return {
    ...mergeUpstreamConfig(base, patch),
    model_override: readString(patch.model_override, base.model_override)
  };
}

function mergeClaudeCompactConfig(
  base: CompactGateRuntimeConfig["claude"]["compact"],
  patch: Record<string, unknown>
): CompactGateRuntimeConfig["claude"]["compact"] {
  return {
    ...mergeUpstreamConfig(base, patch),
    upstream_mode: readString(patch.upstream_mode, base.upstream_mode) as CompactUpstreamMode,
    model_override: readString(patch.model_override, base.model_override)
  };
}
