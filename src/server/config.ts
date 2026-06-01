import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CompactGateConfig,
  CompactModelMode,
  CompactUpstreamMode,
  PublicConfig
} from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";

export const DEFAULT_CONFIG: CompactGateConfig = {
  listen: "127.0.0.1:7865",
  primary: {
    base_url: "https://primary.example/v1",
    api_key: "",
    api_key_env: ""
  },
  compact: {
    base_url: "https://compact.example/v1",
    api_key: "",
    api_key_env: "",
    upstream_mode: "split",
    model_mode: "linked",
    model_template: "{model}-openai-compact",
    model_override: ""
  },
  timeouts: {
    primary_ms: 120_000,
    compact_ms: 900_000
  },
  logging: {
    redact_body: true,
    keep_recent: 200
  }
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ConfigStore {
  private current: CompactGateConfig;

  private lastSavedAt: string | null = null;

  private constructor(
    private readonly configPath: string,
    initial: CompactGateConfig
  ) {
    this.current = initial;
  }

  static async load(configPath: string): Promise<ConfigStore> {
    const resolvedPath = path.resolve(configPath);
    let config = DEFAULT_CONFIG;

    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      config = mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    validateConfig(config);
    return new ConfigStore(resolvedPath, config);
  }

  get(): CompactGateConfig {
    return cloneConfig(this.current);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async patch(patch: unknown): Promise<CompactGateConfig> {
    if (!isRecord(patch)) {
      throw new ConfigError("Config patch must be a JSON object.");
    }

    const next = mergeConfig(this.current, patch);
    validateConfig(next);
    this.current = next;
    await this.save();
    return this.get();
  }

  toPublicConfig(): PublicConfig {
    const config = this.get();
    const primaryCredential = resolveRouteCredential("primary", config);
    const compactCredential = resolveRouteCredential("compact", config);

    return {
      primary: {
        base_url: config.primary.base_url,
        api_key_env: config.primary.api_key_env,
        host: safeHost(config.primary.base_url),
        stored_api_key: directApiKeyConfigured(config.primary.api_key),
        api_key_configured: primaryCredential.apiKeyConfigured,
        api_key_source: primaryCredential.apiKeySource,
        active_api_key_env: primaryCredential.activeApiKeyEnv,
        active_credential_scope: primaryCredential.activeCredentialScope
      },
      compact: {
        base_url: config.compact.base_url,
        api_key_env: config.compact.api_key_env,
        host: safeHost(config.compact.base_url),
        stored_api_key: directApiKeyConfigured(config.compact.api_key),
        api_key_configured: compactCredential.apiKeyConfigured,
        api_key_source: compactCredential.apiKeySource,
        active_api_key_env: compactCredential.activeApiKeyEnv,
        upstream_mode: config.compact.upstream_mode,
        model_mode: config.compact.model_mode,
        model_template: config.compact.model_template,
        model_override: config.compact.model_override,
        active_credential_scope: compactCredential.activeCredentialScope
      },
      listen: config.listen,
      timeouts: config.timeouts,
      logging: config.logging,
      config_path: this.configPath,
      last_saved_at: this.lastSavedAt
    };
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(
      this.configPath,
      `${JSON.stringify(this.current, null, 2)}\n`,
      "utf8"
    );
    this.lastSavedAt = new Date().toISOString();
  }
}

export function validateConfig(config: CompactGateConfig): void {
  validateListen(config.listen);
  validateBaseUrl(config.primary.base_url, "primary.base_url");
  validateBaseUrl(config.compact.base_url, "compact.base_url");
  validateEnvName(config.primary.api_key_env, "primary.api_key_env");
  validateEnvName(config.compact.api_key_env, "compact.api_key_env");
  validateUpstreamMode(config.compact.upstream_mode);
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

  if (!Number.isInteger(config.timeouts.primary_ms) || config.timeouts.primary_ms <= 0) {
    throw new ConfigError("timeouts.primary_ms must be a positive integer.");
  }

  if (!Number.isInteger(config.timeouts.compact_ms) || config.timeouts.compact_ms <= 0) {
    throw new ConfigError("timeouts.compact_ms must be a positive integer.");
  }

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
  const port = Number.parseInt(listen.slice(index + 1), 10);

  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new ConfigError("listen must contain a valid host and port.");
  }

  return { host, port };
}

function validateListen(listen: string): void {
  parseListenAddress(listen);
}

function validateBaseUrl(value: string, field: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
  } catch {
    throw new ConfigError(`${field} must be a valid http or https URL.`);
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

function validateUpstreamMode(value: string): asserts value is CompactUpstreamMode {
  if (value !== "split" && value !== "primary") {
    throw new ConfigError("compact.upstream_mode must be split or primary.");
  }
}

function mergeConfig(base: CompactGateConfig, patch: unknown): CompactGateConfig {
  const patchRecord = isRecord(patch) ? patch : {};

  return {
    listen: readString(patchRecord.listen, base.listen),
    primary: {
      base_url: readString(readChild(patchRecord.primary).base_url, base.primary.base_url),
      api_key: readSensitiveString(readChild(patchRecord.primary).api_key, base.primary.api_key),
      api_key_env: readString(readChild(patchRecord.primary).api_key_env, base.primary.api_key_env)
    },
    compact: {
      base_url: readString(readChild(patchRecord.compact).base_url, base.compact.base_url),
      api_key: readSensitiveString(readChild(patchRecord.compact).api_key, base.compact.api_key),
      api_key_env: readString(readChild(patchRecord.compact).api_key_env, base.compact.api_key_env),
      upstream_mode: readString(
        readChild(patchRecord.compact).upstream_mode,
        base.compact.upstream_mode
      ) as CompactUpstreamMode,
      model_mode: readString(
        readChild(patchRecord.compact).model_mode,
        base.compact.model_mode
      ) as CompactModelMode,
      model_template: readString(
        readChild(patchRecord.compact).model_template,
        base.compact.model_template
      ),
      model_override: readString(
        readChild(patchRecord.compact).model_override,
        base.compact.model_override
      )
    },
    timeouts: {
      primary_ms: readNumber(readChild(patchRecord.timeouts).primary_ms, base.timeouts.primary_ms),
      compact_ms: readNumber(readChild(patchRecord.timeouts).compact_ms, base.timeouts.compact_ms)
    },
    logging: {
      redact_body: readBoolean(readChild(patchRecord.logging).redact_body, base.logging.redact_body),
      keep_recent: readNumber(readChild(patchRecord.logging).keep_recent, base.logging.keep_recent)
    }
  };
}

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid";
  }
}

function readChild(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function readSensitiveString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directApiKeyConfigured(value: string): boolean {
  return value.trim().length > 0;
}
