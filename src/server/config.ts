import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CompactGateConfig,
  CompactGateRuntimeConfig,
  CompactModelMode,
  CompactUpstreamMode,
  PublicConfig,
  PublicConfigProfile,
  SavedConfigProfile
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
  claude: {
    primary: {
      base_url: "https://api.anthropic.com",
      api_key: "",
      api_key_env: "ANTHROPIC_AUTH_TOKEN"
    },
    compact: {
      base_url: "https://api.anthropic.com",
      api_key: "",
      api_key_env: "ANTHROPIC_AUTH_TOKEN",
      upstream_mode: "primary",
      model_override: ""
    }
  },
  timeouts: {
    primary_ms: 120_000,
    compact_ms: 900_000,
    claude_ms: 900_000
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

    const next = {
      ...mergeConfig(this.current, patch),
      active_profile_id: null
    };
    validateConfig(next);
    this.current = next;
    await this.save();
    return this.get();
  }

  async saveProfile(name: string, patch: unknown): Promise<CompactGateConfig> {
    if (!isRecord(patch)) {
      throw new ConfigError("Profile config patch must be a JSON object.");
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new ConfigError("Profile name is required.");
    }

    const now = new Date().toISOString();
    const profileConfig = mergeRuntimeConfig(this.current, patch);
    validateRuntimeConfig(profileConfig);

    const existingProfiles = this.current.profiles ?? [];
    const existing = existingProfiles.find((profile) => profile.name === trimmedName);
    const nextProfile: SavedConfigProfile = {
      id: existing?.id ?? createProfileId(trimmedName, now),
      name: trimmedName,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      config: cloneRuntimeConfig(profileConfig)
    };

    this.current = {
      ...cloneRuntimeConfig(this.current),
      profiles: [
        ...existingProfiles.filter((profile) => profile.id !== nextProfile.id),
        nextProfile
      ],
      active_profile_id: this.current.active_profile_id ?? null
    };
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async updateProfile(profileId: string, name: string | undefined, patch: unknown): Promise<CompactGateConfig> {
    const existingProfiles = this.current.profiles ?? [];
    const profile = existingProfiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    if (!isRecord(patch)) {
      throw new ConfigError("Profile config patch must be a JSON object.");
    }

    const trimmedName = typeof name === "string" ? name.trim() : profile.name;
    if (trimmedName.length === 0) {
      throw new ConfigError("Profile name is required.");
    }

    const duplicateName = existingProfiles.find(
      (item) => item.id !== profileId && item.name === trimmedName
    );
    if (duplicateName) {
      throw new ConfigError("Profile name already exists.");
    }

    const now = new Date().toISOString();
    const profileConfig = mergeRuntimeConfig(profile.config, patch);
    validateRuntimeConfig(profileConfig);

    this.current = {
      ...cloneRuntimeConfig(this.current),
      profiles: existingProfiles.map((item) =>
        item.id === profileId
          ? {
              ...item,
              name: trimmedName,
              updated_at: now,
              config: cloneRuntimeConfig(profileConfig)
            }
          : cloneProfile(item)
      ),
      active_profile_id: this.current.active_profile_id ?? null
    };
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async duplicateProfile(profileId: string, name: string | undefined): Promise<CompactGateConfig> {
    const existingProfiles = this.current.profiles ?? [];
    const profile = existingProfiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    const now = new Date().toISOString();
    const trimmedName = (name?.trim() || `${profile.name} copy`).trim();
    if (trimmedName.length === 0) {
      throw new ConfigError("Profile name is required.");
    }

    if (existingProfiles.some((item) => item.name === trimmedName)) {
      throw new ConfigError("Profile name already exists.");
    }

    const nextProfile: SavedConfigProfile = {
      id: createProfileId(trimmedName, now),
      name: trimmedName,
      created_at: now,
      updated_at: now,
      config: cloneRuntimeConfig(profile.config)
    };

    this.current = {
      ...cloneRuntimeConfig(this.current),
      profiles: [...existingProfiles.map(cloneProfile), nextProfile],
      active_profile_id: this.current.active_profile_id ?? null
    };
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async deleteProfile(profileId: string): Promise<CompactGateConfig> {
    const existingProfiles = this.current.profiles ?? [];
    const profile = existingProfiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    this.current = {
      ...cloneRuntimeConfig(this.current),
      profiles: existingProfiles.filter((item) => item.id !== profileId).map(cloneProfile),
      active_profile_id:
        this.current.active_profile_id === profileId
          ? null
          : this.current.active_profile_id ?? null
    };
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async applyProfile(profileId: string): Promise<CompactGateConfig> {
    const profile = (this.current.profiles ?? []).find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    const nextRuntime = cloneRuntimeConfig(profile.config);
    validateRuntimeConfig(nextRuntime);
    this.current = {
      ...nextRuntime,
      profiles: this.current.profiles ?? [],
      active_profile_id: profile.id
    };
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  toPublicConfig(): PublicConfig {
    const config = this.get();
    const primaryCredential = resolveRouteCredential("primary", config);
    const compactCredential = resolveRouteCredential("compact", config);
    const claudePrimaryCredential = resolveRouteCredential("claude_primary", config);
    const claudeCompactCredential = resolveRouteCredential("claude_compact", config);

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
      claude: {
        primary: {
          base_url: config.claude.primary.base_url,
          api_key_env: config.claude.primary.api_key_env,
          host: safeHost(config.claude.primary.base_url),
          stored_api_key: directApiKeyConfigured(config.claude.primary.api_key),
          api_key_configured: claudePrimaryCredential.apiKeyConfigured,
          api_key_source: claudePrimaryCredential.apiKeySource,
          active_api_key_env: claudePrimaryCredential.activeApiKeyEnv,
          active_credential_scope: claudePrimaryCredential.activeCredentialScope
        },
        compact: {
          base_url: config.claude.compact.base_url,
          api_key_env: config.claude.compact.api_key_env,
          host: safeHost(config.claude.compact.base_url),
          stored_api_key: directApiKeyConfigured(config.claude.compact.api_key),
          api_key_configured: claudeCompactCredential.apiKeyConfigured,
          api_key_source: claudeCompactCredential.apiKeySource,
          active_api_key_env: claudeCompactCredential.activeApiKeyEnv,
          active_credential_scope: claudeCompactCredential.activeCredentialScope,
          upstream_mode: config.claude.compact.upstream_mode,
          model_override: config.claude.compact.model_override
        }
      },
      listen: config.listen,
      timeouts: config.timeouts,
      logging: config.logging,
      profiles: (config.profiles ?? []).map(toPublicProfile),
      active_profile_id: config.active_profile_id ?? null,
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
  validateRuntimeConfig(config);

  for (const profile of config.profiles ?? []) {
    if (profile.id.trim().length === 0) {
      throw new ConfigError("profile.id is required.");
    }

    if (profile.name.trim().length === 0) {
      throw new ConfigError("profile.name is required.");
    }

    validateRuntimeConfig(profile.config);
  }

  if (
    config.active_profile_id &&
    !(config.profiles ?? []).some((profile) => profile.id === config.active_profile_id)
  ) {
    throw new ConfigError("active_profile_id must reference an existing profile.");
  }
}

function validateRuntimeConfig(config: CompactGateRuntimeConfig): void {
  validateListen(config.listen);
  validateBaseUrl(config.primary.base_url, "primary.base_url");
  validateBaseUrl(config.compact.base_url, "compact.base_url");
  validateBaseUrl(config.claude.primary.base_url, "claude.primary.base_url");
  validateBaseUrl(config.claude.compact.base_url, "claude.compact.base_url");
  validateEnvName(config.primary.api_key_env, "primary.api_key_env");
  validateEnvName(config.compact.api_key_env, "compact.api_key_env");
  validateEnvName(config.claude.primary.api_key_env, "claude.primary.api_key_env");
  validateEnvName(config.claude.compact.api_key_env, "claude.compact.api_key_env");
  validateOptionalModelName(config.claude.compact.model_override, "claude.compact.model_override");
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

  if (!Number.isInteger(config.timeouts.primary_ms) || config.timeouts.primary_ms <= 0) {
    throw new ConfigError("timeouts.primary_ms must be a positive integer.");
  }

  if (!Number.isInteger(config.timeouts.compact_ms) || config.timeouts.compact_ms <= 0) {
    throw new ConfigError("timeouts.compact_ms must be a positive integer.");
  }

  if (!Number.isInteger(config.timeouts.claude_ms) || config.timeouts.claude_ms <= 0) {
    throw new ConfigError("timeouts.claude_ms must be a positive integer.");
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

function validateOptionalModelName(value: string, field: string): void {
  if (value.trim().length > 256) {
    throw new ConfigError(`${field} must be 256 characters or fewer.`);
  }
}

function validateUpstreamMode(value: string): asserts value is CompactUpstreamMode {
  if (value !== "split" && value !== "primary") {
    throw new ConfigError("compact.upstream_mode must be split or primary.");
  }
}

function mergeConfig(base: CompactGateConfig, patch: unknown): CompactGateConfig {
  const patchRecord = isRecord(patch) ? patch : {};
  const runtime = mergeRuntimeConfig(base, patchRecord);

  return {
    ...runtime,
    profiles: mergeProfiles(base.profiles ?? [], patchRecord.profiles),
    active_profile_id: readActiveProfileId(
      patchRecord.active_profile_id,
      base.active_profile_id ?? null
    )
  };
}

function mergeRuntimeConfig(
  base: CompactGateRuntimeConfig,
  patch: unknown
): CompactGateRuntimeConfig {
  const patchRecord = isRecord(patch) ? patch : {};

  return {
    listen: readString(patchRecord.listen, base.listen),
    primary: mergeUpstreamConfig(base.primary, readChild(patchRecord.primary)),
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
    claude: mergeClaudeConfig(base.claude, readChild(patchRecord.claude)),
    timeouts: {
      primary_ms: readNumber(readChild(patchRecord.timeouts).primary_ms, base.timeouts.primary_ms),
      compact_ms: readNumber(readChild(patchRecord.timeouts).compact_ms, base.timeouts.compact_ms),
      claude_ms: readNumber(readChild(patchRecord.timeouts).claude_ms, base.timeouts.claude_ms)
    },
    logging: {
      redact_body: readBoolean(readChild(patchRecord.logging).redact_body, base.logging.redact_body),
      keep_recent: readNumber(readChild(patchRecord.logging).keep_recent, base.logging.keep_recent)
    }
  };
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

  if (Object.keys(primaryPatch).length > 0 || Object.keys(compactPatch).length > 0) {
    return {
      primary: mergeUpstreamConfig(base.primary, primaryPatch),
      compact: mergeClaudeCompactConfig(base.compact, compactPatch)
    };
  }

  if (Object.hasOwn(patch, "base_url") || Object.hasOwn(patch, "api_key") || Object.hasOwn(patch, "api_key_env")) {
    const legacy = mergeUpstreamConfig(base.primary, patch);
    return {
      primary: legacy,
      compact: {
        ...legacy,
        upstream_mode: base.compact.upstream_mode,
        model_override: base.compact.model_override
      }
    };
  }

  return {
    primary: { ...base.primary },
    compact: { ...base.compact }
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

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}

function cloneRuntimeConfig(config: CompactGateRuntimeConfig): CompactGateRuntimeConfig {
  return JSON.parse(JSON.stringify({
    listen: config.listen,
    primary: config.primary,
    compact: config.compact,
    claude: config.claude,
    timeouts: config.timeouts,
    logging: config.logging
  })) as CompactGateRuntimeConfig;
}

function mergeProfiles(
  baseProfiles: SavedConfigProfile[],
  value: unknown
): SavedConfigProfile[] {
  if (!Array.isArray(value)) {
    return baseProfiles.map(cloneProfile);
  }

  return value
    .map((item) => readProfile(item))
    .filter((item): item is SavedConfigProfile => item !== null);
}

function readProfile(value: unknown): SavedConfigProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value.id, "");
  const name = readString(value.name, "");
  if (!id || !name) {
    return null;
  }

  const config = mergeRuntimeConfig(DEFAULT_CONFIG, readChild(value.config));
  return {
    id,
    name,
    created_at: readString(value.created_at, new Date(0).toISOString()),
    updated_at: readString(value.updated_at, new Date(0).toISOString()),
    config
  };
}

function cloneProfile(profile: SavedConfigProfile): SavedConfigProfile {
  return {
    id: profile.id,
    name: profile.name,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    config: cloneRuntimeConfig(profile.config)
  };
}

function readActiveProfileId(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }

  return typeof value === "string" ? value.trim() || null : fallback;
}

function createProfileId(name: string, isoTime: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "profile";
  return `${slug}-${Date.parse(isoTime).toString(36)}`;
}

function toPublicProfile(profile: SavedConfigProfile): PublicConfigProfile {
  return {
    id: profile.id,
    name: profile.name,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    primary_host: safeHost(profile.config.primary.base_url),
    compact_host: safeHost(profile.config.compact.base_url),
    claude_primary_host: safeHost(profile.config.claude.primary.base_url),
    claude_compact_host: safeHost(profile.config.claude.compact.base_url),
    compact_upstream_mode: profile.config.compact.upstream_mode,
    claude_compact_upstream_mode: profile.config.claude.compact.upstream_mode,
    stored_api_key_count: [
      profile.config.primary.api_key,
      profile.config.compact.api_key,
      profile.config.claude.primary.api_key,
      profile.config.claude.compact.api_key
    ].filter(directApiKeyConfigured).length
  };
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
