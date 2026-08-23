import { validateHeaderName, validateHeaderValue } from "node:http";
import type {
  ClaudeModelMap,
  ClaudeSceneMap,
  CompactGateRuntimeConfig,
  CompactModelMode,
  CompactUpstreamMode,
  PrimaryReasoningEffort,
  PrimaryStatePortabilityMode,
  UpstreamConfig,
  UpstreamProtocol
} from "../shared/types.js";
import { CLAUDE_MODEL_MAP_ROLES, CLAUDE_SCENES } from "./config-defaults.js";
import {
  ConfigError,
  isRecord,
  isValidBaseUrl,
  readBoolean,
  readChild,
  readNullableString,
  readNumber,
  readString
} from "./config-internals.js";
import { parseHttpConnectProxyUrl } from "./upstream-proxy-url.js";

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const MAX_EXTRA_HEADERS = 64;
const MAX_EXTRA_HEADER_BYTES = 16 * 1024;
const FORBIDDEN_EXTRA_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "x-api-key",
  "api-key",
  "anthropic-api-key",
  "x-anthropic-api-key",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function validateRuntimeConfig(config: CompactGateRuntimeConfig): void {
  parseListenAddress(config.listen);
  // ponytail: per-route grouping means a config broken in two categories now surfaces the
  // first route's error instead of the first category's. Messages are unchanged; if error
  // precedence ever becomes contractual, hoist each check back into its own loop.
  for (const [field, upstream] of [
    ["primary", config.primary],
    ["compact", config.compact],
    ["claude.primary", config.claude.primary],
    ["claude.compact", config.claude.compact]
  ] as const) {
    validateBaseUrl(upstream.base_url, `${field}.base_url`);
    validateUpstreamProtocol(upstream.upstream_protocol, `${field}.upstream_protocol`);
    validateEnvName(upstream.api_key_env, `${field}.api_key_env`);
    validateExtraHeaders(upstream.extra_headers, `${field}.extra_headers`);
    validateProxyUrl(upstream.proxy_url, upstream.base_url, `${field}.proxy_url`);
  }
  validateOptionalModelName(config.primary.model_override ?? "", "primary.model_override");
  validatePrimaryReasoningEffort(config.primary.reasoning_effort);
  validateStateDomainId(config.primary.state_domain_id);
  validateOptionalModelName(config.claude.primary.model_override, "claude.primary.model_override");
  validateOptionalModelName(config.claude.compact.model_override, "claude.compact.model_override");
  validateClaudeModelMap(config.claude.model_map);
  validateClaudeSceneMap(config.claude.scene_map);
  if (
    !Number.isInteger(config.claude.long_context_bytes) ||
    config.claude.long_context_bytes < 0 ||
    config.claude.long_context_bytes > 100 * 1024 * 1024
  ) {
    throw new ConfigError("claude.long_context_bytes must be between 0 and 104857600.");
  }
  validateUpstreamMode(config.compact.upstream_mode, "compact.upstream_mode");
  validateUpstreamMode(config.claude.compact.upstream_mode, "claude.compact.upstream_mode");
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

  if (
    !Number.isInteger(config.logging.capture_body_max_bytes) ||
    config.logging.capture_body_max_bytes <= 0
  ) {
    throw new ConfigError("logging.capture_body_max_bytes must be a positive integer byte count.");
  }

  if (
    !Number.isInteger(config.logging.capture_dir_max_bytes) ||
    config.logging.capture_dir_max_bytes <= 0
  ) {
    throw new ConfigError("logging.capture_dir_max_bytes must be a positive integer byte count.");
  }

  if (
    !Number.isInteger(config.logging.max_database_bytes) ||
    config.logging.max_database_bytes <= 0
  ) {
    throw new ConfigError("logging.max_database_bytes must be a positive integer byte count.");
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
  if (!isValidBaseUrl(value)) {
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
    primary: mergePrimaryConfig(base.primary, readChild(patchRecord.primary)),
    compact: {
      ...mergeUpstreamConfig(base.compact, compactPatch),
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
      keep_recent: readNumber(readChild(patchRecord.logging).keep_recent, base.logging.keep_recent),
      capture_dir: readNullableString(
        readChild(patchRecord.logging).capture_dir,
        base.logging.capture_dir
      ),
      capture_body_max_bytes: readNumber(
        readChild(patchRecord.logging).capture_body_max_bytes,
        base.logging.capture_body_max_bytes
      ),
      capture_dir_max_bytes: readNumber(
        readChild(patchRecord.logging).capture_dir_max_bytes,
        base.logging.capture_dir_max_bytes
      ),
      max_database_bytes: readNumber(
        readChild(patchRecord.logging).max_database_bytes,
        base.logging.max_database_bytes
      )
    },
    primary_failover: {
      auto_schedule: readBoolean(
        readChild(patchRecord.primary_failover).auto_schedule,
        base.primary_failover.auto_schedule
      ),
      state_portability: readPrimaryStatePortabilityMode(
        readChild(patchRecord.primary_failover).state_portability,
        base.primary_failover.state_portability
      )
    }
  };
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
  if (!["off", "recover_on_error"].includes(value.state_portability)) {
    throw new ConfigError(
      "primary_failover.state_portability must be off or recover_on_error."
    );
  }
}

function readPrimaryStatePortabilityMode(
  value: unknown,
  fallback: PrimaryStatePortabilityMode
): PrimaryStatePortabilityMode {
  const raw = readString(value, fallback);
  if (raw === "compatibility_first" || raw === "domain_aware") {
    return "recover_on_error";
  }
  return raw as PrimaryStatePortabilityMode;
}

function validateStateDomainId(value: string): void {
  if (value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConfigError("primary.state_domain_id must be at most 256 printable characters without surrounding whitespace.");
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

function validateExtraHeaders(value: Record<string, string>, field: string): void {
  const entries = Object.entries(value);
  if (entries.length > MAX_EXTRA_HEADERS) {
    throw new ConfigError(`${field} must contain at most ${MAX_EXTRA_HEADERS} headers.`);
  }

  let totalBytes = 0;
  for (const [name, headerValue] of entries) {
    const lowerName = name.toLowerCase();
    if (FORBIDDEN_EXTRA_HEADERS.has(lowerName)) {
      throw new ConfigError(`${field}.${name} cannot override a protected header.`);
    }
    try {
      validateHeaderName(name);
      validateHeaderValue(name, headerValue);
    } catch {
      throw new ConfigError(`${field}.${name} must be a valid HTTP header.`);
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(headerValue);
  }

  if (totalBytes > MAX_EXTRA_HEADER_BYTES) {
    throw new ConfigError(`${field} must be ${MAX_EXTRA_HEADER_BYTES} bytes or fewer.`);
  }
}

function validateProxyUrl(value: string, baseUrl: string, field: string): void {
  if (value.trim().length === 0) {
    return;
  }
  if (new URL(baseUrl).protocol !== "https:") {
    throw new ConfigError(`${field} requires an https upstream URL.`);
  }
  try {
    parseHttpConnectProxyUrl(value);
  } catch (error) {
    throw new ConfigError(`${field}: ${error instanceof Error ? error.message : "Invalid proxy URL."}`);
  }
}

function validateModelMode(value: string): asserts value is CompactModelMode {
  if (value !== "linked" && value !== "custom") {
    throw new ConfigError("compact.model_mode must be linked or custom.");
  }
}

function validatePrimaryReasoningEffort(value: string): asserts value is PrimaryReasoningEffort {
  if (!["", "none", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new ConfigError(
      "primary.reasoning_effort must be empty, none, low, medium, high, xhigh, or max."
    );
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

function validateClaudeSceneMap(sceneMap: ClaudeSceneMap): void {
  for (const scene of CLAUDE_SCENES) {
    const target = sceneMap[scene];
    if (
      target.profile_id.length > 256 ||
      target.profile_id.trim() !== target.profile_id ||
      /[\u0000-\u001f\u007f]/.test(target.profile_id)
    ) {
      throw new ConfigError(
        `claude.scene_map.${scene}.profile_id must be at most 256 printable characters without surrounding whitespace.`
      );
    }
    validateOptionalModelName(target.model, `claude.scene_map.${scene}.model`);
  }
}

function validateUpstreamMode(value: string, field: string): asserts value is CompactUpstreamMode {
  if (value !== "split" && value !== "primary") {
    // Named field: a bad `claude.compact.upstream_mode` used to report
    // `compact.upstream_mode`, pointing the reader at the Codex route.
    throw new ConfigError(`${field} must be split or primary.`);
  }
}

function validateUpstreamProtocol(value: string, field: string): asserts value is UpstreamProtocol {
  if (!["openai_responses", "anthropic_messages", "openai_chat"].includes(value)) {
    throw new ConfigError(`${field} must be openai_responses, anthropic_messages, or openai_chat.`);
  }
}

function readUpstreamProtocol(value: unknown, fallback: UpstreamProtocol): UpstreamProtocol {
  return readString(value, fallback) as UpstreamProtocol;
}

function mergeUpstreamConfig(
  base: UpstreamConfig,
  patch: Record<string, unknown>
): UpstreamConfig & { model_override: string } {
  return {
    base_url: readString(patch.base_url, base.base_url),
    api_key: readString(patch.api_key, base.api_key),
    api_key_env: readString(patch.api_key_env, base.api_key_env),
    extra_headers: readExtraHeaders(patch.extra_headers, base.extra_headers),
    proxy_url: readString(patch.proxy_url, base.proxy_url),
    upstream_protocol: readUpstreamProtocol(patch.upstream_protocol, base.upstream_protocol),
    model_override: readString(patch.model_override, base.model_override ?? "")
  };
}

function readExtraHeaders(
  value: unknown,
  fallback: Record<string, string>
): Record<string, string> {
  if (value === undefined) {
    return { ...fallback };
  }
  if (!isRecord(value)) {
    throw new ConfigError("extra_headers must be a JSON object containing string values.");
  }

  const next: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new ConfigError("extra_headers must be a JSON object containing string values.");
    }
    const lowerName = name.toLowerCase();
    if (Object.hasOwn(next, lowerName)) {
      throw new ConfigError(`extra_headers contains a duplicate header: ${name}.`);
    }
    next[lowerName] = headerValue;
  }
  return next;
}

function mergePrimaryConfig(
  base: CompactGateRuntimeConfig["primary"],
  patch: Record<string, unknown>
): CompactGateRuntimeConfig["primary"] {
  return {
    ...mergeUpstreamConfig(base, patch),
    reasoning_effort: readString(
      patch.reasoning_effort,
      base.reasoning_effort
    ) as PrimaryReasoningEffort,
    state_domain_id: readString(patch.state_domain_id, base.state_domain_id)
  };
}

function mergeClaudeConfig(
  base: CompactGateRuntimeConfig["claude"],
  patch: Record<string, unknown>
): CompactGateRuntimeConfig["claude"] {
  const primaryPatch = readChild(patch.primary);
  const compactPatch = readChild(patch.compact);
  const modelMapPatch = readChild(patch.model_map);
  const sceneMapPatch = readChild(patch.scene_map);
  const hasModelMapPatch = Object.keys(modelMapPatch).length > 0;
  const sceneMap = mergeClaudeSceneMap(base.scene_map, sceneMapPatch);
  const longContextBytes = readNumber(patch.long_context_bytes, base.long_context_bytes);

  if (Object.keys(primaryPatch).length > 0 || Object.keys(compactPatch).length > 0) {
    const modelMap = mergeClaudeModelMap(base.model_map, modelMapPatch);
    if (!hasModelMapPatch && typeof primaryPatch.model_override === "string") {
      modelMap.default = primaryPatch.model_override.trim();
    }
    return {
      primary: {
        ...mergeUpstreamConfig(base.primary, primaryPatch),
        model_override: modelMap.default
      },
      compact: mergeClaudeCompactConfig(base.compact, compactPatch),
      model_map: modelMap,
      scene_map: sceneMap,
      long_context_bytes: longContextBytes
    };
  }

  if (
    Object.hasOwn(patch, "base_url") ||
    Object.hasOwn(patch, "api_key") ||
    Object.hasOwn(patch, "api_key_env") ||
    Object.hasOwn(patch, "extra_headers") ||
    Object.hasOwn(patch, "proxy_url")
  ) {
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
      model_map: modelMap,
      scene_map: sceneMap,
      long_context_bytes: longContextBytes
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
      model_map: modelMap,
      scene_map: sceneMap,
      long_context_bytes: longContextBytes
    };
  }

  return {
    primary: {
      ...base.primary,
      model_override: base.model_map.default
    },
    compact: { ...base.compact },
    model_map: { ...base.model_map },
    scene_map: sceneMap,
    long_context_bytes: longContextBytes
  };
}

function mergeClaudeModelMap(base: ClaudeModelMap, patch: Record<string, unknown>): ClaudeModelMap {
  const next = { ...base };

  for (const role of CLAUDE_MODEL_MAP_ROLES) {
    next[role] = readString(patch[role], next[role]);
  }

  return next;
}

function mergeClaudeSceneMap(base: ClaudeSceneMap, patch: Record<string, unknown>): ClaudeSceneMap {
  const next = { ...base };
  for (const scene of CLAUDE_SCENES) {
    const target = readChild(patch[scene]);
    next[scene] = {
      profile_id: readString(target.profile_id, base[scene].profile_id),
      model: readString(target.model, base[scene].model)
    };
  }
  return next;
}

function mergeClaudeCompactConfig(
  base: CompactGateRuntimeConfig["claude"]["compact"],
  patch: Record<string, unknown>
): CompactGateRuntimeConfig["claude"]["compact"] {
  return {
    ...mergeUpstreamConfig(base, patch),
    upstream_mode: readString(patch.upstream_mode, base.upstream_mode) as CompactUpstreamMode
  };
}
