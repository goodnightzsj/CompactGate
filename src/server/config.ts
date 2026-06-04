import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ClaudeModelMap,
  ClaudeModelMapRole,
  CompactGateConfig,
  CompactGateRuntimeConfig,
  CompactModelMode,
  CompactUpstreamMode,
  ConfigProfileScope,
  PublicConfig,
  PublicConfigProfile,
  SavedClaudeProfileConfig,
  SavedCodexProfileConfig,
  SavedConfigProfile,
  SavedConfigProfileConfig,
  SavedConfigProfileScopeState,
  SavedConfigProfileScopes
} from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";

const CLAUDE_MODEL_MAP_ROLES: ClaudeModelMapRole[] = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "reasoning",
  "subagent"
];

function emptyClaudeModelMap(): ClaudeModelMap {
  return {
    default: "",
    opus: "",
    sonnet: "",
    haiku: "",
    reasoning: "",
    subagent: ""
  };
}

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
      api_key_env: "ANTHROPIC_AUTH_TOKEN",
      model_override: ""
    },
    compact: {
      base_url: "https://api.anthropic.com",
      api_key: "",
      api_key_env: "ANTHROPIC_AUTH_TOKEN",
      upstream_mode: "primary",
      model_override: ""
    },
    model_map: emptyClaudeModelMap()
  },
  timeouts: {
    primary_ms: 120_000,
    compact_ms: 900_000,
    claude_ms: 900_000
  },
  logging: {
    redact_body: true,
    keep_recent: 200
  },
  profile_scopes: {
    codex: {
      profiles: [],
      active_profile_id: null
    },
    claude: {
      profiles: [],
      active_profile_id: null
    }
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
    let shouldPersistNormalizedProfiles = false;

    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      const parsed = JSON.parse(raw);
      config = mergeConfig(DEFAULT_CONFIG, parsed);
      shouldPersistNormalizedProfiles = shouldPersistProfileNormalization(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    validateConfig(config);
    const store = new ConfigStore(resolvedPath, config);
    if (shouldPersistNormalizedProfiles) {
      await store.save();
    }
    return store;
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

    const merged = mergeConfig(this.current, patch);
    const next = {
      ...merged,
      profiles: undefined,
      active_profile_id: null,
      profile_scopes: clearActiveProfileIds(merged.profile_scopes)
    };
    validateConfig(next);
    this.current = next;
    await this.save();
    return this.get();
  }

  async saveProfile(
    scopeOrName: ConfigProfileScope | string,
    nameOrPatch: string | unknown,
    maybePatch?: unknown
  ): Promise<CompactGateConfig> {
    const { scope, name, patch } = normalizeProfileOperationArgs(scopeOrName, nameOrPatch, maybePatch);
    return this.saveScopedProfile(scope, name, patch);
  }

  private async saveScopedProfile(scope: ConfigProfileScope, name: string, patch: unknown): Promise<CompactGateConfig> {
    if (!isRecord(patch)) {
      throw new ConfigError("Profile config patch must be a JSON object.");
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new ConfigError("Profile name is required.");
    }

    const now = new Date().toISOString();
    const profileConfig = createScopedProfileConfig(this.current, patch, scope);
    validateProfileConfig(profileConfig, scope);

    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    const existing = existingProfiles.find((profile) => profile.name === trimmedName);
    const nextProfile: SavedConfigProfile = {
      id: existing?.id ?? createProfileId(`${scope}-${trimmedName}`, now),
      name: trimmedName,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      config: cloneProfileConfig(profileConfig)
    };

    this.current = withProfileScope(this.current, scope, {
      profiles: [
        ...existingProfiles.filter((profile) => profile.id !== nextProfile.id).map(cloneProfile),
        nextProfile
      ],
      active_profile_id: scopeState.active_profile_id ?? null
    });
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async updateProfile(
    scopeOrProfileId: ConfigProfileScope | string,
    profileIdOrName: string | undefined,
    nameOrPatch?: string | unknown,
    maybePatch?: unknown
  ): Promise<CompactGateConfig> {
    const { scope, profileId, name, patch } = normalizeProfileMutationArgs(
      scopeOrProfileId,
      profileIdOrName,
      nameOrPatch,
      maybePatch
    );
    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
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
    const profileConfig = updateScopedProfileConfig(profile.config, patch, scope);
    validateProfileConfig(profileConfig, scope);
    const nextScopeState = {
      profiles: existingProfiles.map((item) =>
        item.id === profileId
          ? {
              ...item,
              name: trimmedName,
              updated_at: now,
              config: cloneProfileConfig(profileConfig)
            }
          : cloneProfile(item)
      ),
      active_profile_id: scopeState.active_profile_id ?? null
    };

    const nextConfig = withProfileScope(this.current, scope, nextScopeState);
    this.current =
      scopeState.active_profile_id === profileId
        ? {
            ...nextConfig,
            ...mergeRuntimeForProfileScope(nextConfig, profileConfig, scope)
          }
        : nextConfig;
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async duplicateProfile(
    scopeOrProfileId: ConfigProfileScope | string,
    profileIdOrName?: string,
    maybeName?: string
  ): Promise<CompactGateConfig> {
    const { scope, profileId, name } = normalizeProfileIdNameArgs(scopeOrProfileId, profileIdOrName, maybeName);
    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
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
      id: createProfileId(`${scope}-${trimmedName}`, now),
      name: trimmedName,
      created_at: now,
      updated_at: now,
      config: cloneProfileConfig(profile.config)
    };

    this.current = withProfileScope(this.current, scope, {
      profiles: [...existingProfiles.map(cloneProfile), nextProfile],
      active_profile_id: scopeState.active_profile_id ?? null
    });
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async deleteProfile(scopeOrProfileId: ConfigProfileScope | string, maybeProfileId?: string): Promise<CompactGateConfig> {
    const { scope, profileId } = normalizeProfileIdArgs(scopeOrProfileId, maybeProfileId);
    const scopeState = getProfileScopeState(this.current, scope);
    const existingProfiles = scopeState.profiles ?? [];
    const profile = existingProfiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    this.current = withProfileScope(this.current, scope, {
      profiles: existingProfiles.filter((item) => item.id !== profileId).map(cloneProfile),
      active_profile_id:
        scopeState.active_profile_id === profileId
          ? null
          : scopeState.active_profile_id ?? null
    });
    validateConfig(this.current);
    await this.save();
    return this.get();
  }

  async applyProfile(scopeOrProfileId: ConfigProfileScope | string, maybeProfileId?: string): Promise<CompactGateConfig> {
    const { scope, profileId } = normalizeProfileIdArgs(scopeOrProfileId, maybeProfileId);
    const scopeState = getProfileScopeState(this.current, scope);
    const profile = (scopeState.profiles ?? []).find((item) => item.id === profileId);
    if (!profile) {
      throw new ConfigError("Profile not found.");
    }

    const nextRuntime = mergeRuntimeForProfileScope(this.current, profile.config, scope);
    validateRuntimeConfig(nextRuntime);
    this.current = withProfileScope(
      {
        ...nextRuntime,
        profile_scopes: this.current.profile_scopes
      },
      scope,
      {
        profiles: scopeState.profiles ?? [],
        active_profile_id: profile.id
      }
    );
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
          active_credential_scope: claudePrimaryCredential.activeCredentialScope,
          model_override: config.claude.primary.model_override
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
        },
        model_map: { ...config.claude.model_map }
      },
      listen: config.listen,
      timeouts: config.timeouts,
      logging: config.logging,
      profiles: getProfileScopeState(config, "codex").profiles.map((profile) => toPublicProfile(profile, "codex")),
      active_profile_id: getProfileScopeState(config, "codex").active_profile_id ?? null,
      profile_scopes: {
        codex: publicProfileScope(config, "codex"),
        claude: publicProfileScope(config, "claude")
      },
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

  for (const scope of PROFILE_SCOPES) {
    const state = getProfileScopeState(config, scope);
    for (const profile of state.profiles) {
      if (profile.id.trim().length === 0) {
        throw new ConfigError("profile.id is required.");
      }

      if (profile.name.trim().length === 0) {
        throw new ConfigError("profile.name is required.");
      }

      validateProfileConfig(profile.config, scope);
    }

    if (state.active_profile_id && !state.profiles.some((profile) => profile.id === state.active_profile_id)) {
      throw new ConfigError(`${scope}.active_profile_id must reference an existing profile.`);
    }
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

function mergeConfig(base: CompactGateConfig, patch: unknown): CompactGateConfig {
  const patchRecord = isRecord(patch) ? patch : {};
  const runtime = mergeRuntimeConfig(base, patchRecord);
  const profileScopes = mergeProfileScopes(base, patchRecord);

  return {
    ...runtime,
    profiles: undefined,
    active_profile_id: profileScopes.codex?.active_profile_id ?? null,
    profile_scopes: profileScopes
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

function mergeRuntimeForProfileScope(
  current: CompactGateRuntimeConfig,
  profile: SavedConfigProfileConfig,
  scope: ConfigProfileScope
): CompactGateRuntimeConfig {
  const profileRuntime = profileConfigToRuntime(profile);

  if (scope === "codex") {
    return {
      ...cloneRuntimeConfig(current),
      primary: { ...profileRuntime.primary },
      compact: { ...profileRuntime.compact }
    };
  }

  return {
    ...cloneRuntimeConfig(current),
    claude: {
      primary: { ...profileRuntime.claude.primary },
      compact: { ...profileRuntime.claude.compact },
      model_map: { ...profileRuntime.claude.model_map }
    }
  };
}

function createScopedProfileConfig(
  current: CompactGateRuntimeConfig,
  patch: unknown,
  scope: ConfigProfileScope
): SavedConfigProfileConfig {
  return extractScopedProfileConfig(mergeRuntimeConfig(current, patch), scope);
}

function updateScopedProfileConfig(
  current: SavedConfigProfileConfig,
  patch: unknown,
  scope: ConfigProfileScope
): SavedConfigProfileConfig {
  return extractScopedProfileConfig(mergeRuntimeConfig(profileConfigToRuntime(current), patch), scope);
}

function extractScopedProfileConfig(
  runtime: CompactGateRuntimeConfig,
  scope: ConfigProfileScope
): SavedCodexProfileConfig | SavedClaudeProfileConfig {
  if (scope === "codex") {
    return {
      primary: { ...runtime.primary },
      compact: { ...runtime.compact }
    };
  }

  return {
    claude: {
      primary: { ...runtime.claude.primary },
      compact: { ...runtime.claude.compact },
      model_map: { ...runtime.claude.model_map }
    }
  };
}

function profileConfigToRuntime(config: SavedConfigProfileConfig): CompactGateRuntimeConfig {
  return mergeRuntimeConfig(DEFAULT_CONFIG, config);
}

function validateProfileConfig(config: SavedConfigProfileConfig, scope: ConfigProfileScope): void {
  validateRuntimeConfig(profileConfigToRuntime(extractScopedProfileConfig(profileConfigToRuntime(config), scope)));
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

function cloneProfileConfig(config: SavedConfigProfileConfig): SavedConfigProfileConfig {
  return JSON.parse(JSON.stringify(config)) as SavedConfigProfileConfig;
}

function shouldPersistProfileNormalization(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (Array.isArray(value.profiles)) {
    return true;
  }

  const profileScopes = readChild(value.profile_scopes);
  return (
    profileScopeNeedsNormalization(readChild(profileScopes.codex), "codex") ||
    profileScopeNeedsNormalization(readChild(profileScopes.claude), "claude")
  );
}

function profileScopeNeedsNormalization(
  value: Record<string, unknown>,
  scope: ConfigProfileScope
): boolean {
  if (!Array.isArray(value.profiles)) {
    return false;
  }

  return value.profiles.some((profile) => {
    if (!isRecord(profile) || !isRecord(profile.config)) {
      return false;
    }

    if (scope === "codex") {
      return (
        Object.hasOwn(profile.config, "claude") ||
        Object.hasOwn(profile.config, "listen") ||
        Object.hasOwn(profile.config, "timeouts") ||
        Object.hasOwn(profile.config, "logging")
      );
    }

    return (
      Object.hasOwn(profile.config, "primary") ||
      Object.hasOwn(profile.config, "compact") ||
      Object.hasOwn(profile.config, "listen") ||
      Object.hasOwn(profile.config, "timeouts") ||
      Object.hasOwn(profile.config, "logging")
    );
  });
}


const PROFILE_SCOPES: ConfigProfileScope[] = ["codex", "claude"];

function normalizeProfileOperationArgs(
  scopeOrName: ConfigProfileScope | string,
  nameOrPatch: string | unknown,
  maybePatch?: unknown
): { scope: ConfigProfileScope; name: string; patch: unknown } {
  if (isProfileScope(scopeOrName) && typeof nameOrPatch === "string") {
    return { scope: scopeOrName, name: nameOrPatch, patch: maybePatch ?? {} };
  }

  return { scope: "codex", name: scopeOrName, patch: nameOrPatch ?? {} };
}

function normalizeProfileMutationArgs(
  scopeOrProfileId: ConfigProfileScope | string,
  profileIdOrName: string | undefined,
  nameOrPatch?: string | unknown,
  maybePatch?: unknown
): { scope: ConfigProfileScope; profileId: string; name: string | undefined; patch: unknown } {
  if (isProfileScope(scopeOrProfileId)) {
    return {
      scope: scopeOrProfileId,
      profileId: profileIdOrName ?? "",
      name: typeof nameOrPatch === "string" ? nameOrPatch : undefined,
      patch: maybePatch ?? (typeof nameOrPatch === "string" ? {} : nameOrPatch ?? {})
    };
  }

  return {
    scope: "codex",
    profileId: scopeOrProfileId,
    name: profileIdOrName,
    patch: nameOrPatch ?? {}
  };
}

function normalizeProfileIdNameArgs(
  scopeOrProfileId: ConfigProfileScope | string,
  profileIdOrName?: string,
  maybeName?: string
): { scope: ConfigProfileScope; profileId: string; name: string | undefined } {
  if (isProfileScope(scopeOrProfileId)) {
    return { scope: scopeOrProfileId, profileId: profileIdOrName ?? "", name: maybeName };
  }

  return { scope: "codex", profileId: scopeOrProfileId, name: profileIdOrName };
}

function normalizeProfileIdArgs(
  scopeOrProfileId: ConfigProfileScope | string,
  maybeProfileId?: string
): { scope: ConfigProfileScope; profileId: string } {
  if (isProfileScope(scopeOrProfileId)) {
    return { scope: scopeOrProfileId, profileId: maybeProfileId ?? "" };
  }

  return { scope: "codex", profileId: scopeOrProfileId };
}

function isProfileScope(value: string): value is ConfigProfileScope {
  return value === "codex" || value === "claude";
}

function getProfileScopeState(
  config: CompactGateConfig,
  scope: ConfigProfileScope
): { profiles: SavedConfigProfile[]; active_profile_id: string | null } {
  const scoped = config.profile_scopes?.[scope];
  return {
    profiles: (scoped?.profiles ?? []).map(cloneProfile),
    active_profile_id: scoped?.active_profile_id ?? null
  };
}

function withProfileScope(
  config: CompactGateConfig,
  scope: ConfigProfileScope,
  state: SavedConfigProfileScopeState
): CompactGateConfig {
  const previousScopes = config.profile_scopes ?? {};
  const nextScopes: SavedConfigProfileScopes = {
    codex: cloneProfileScope(previousScopes.codex),
    claude: cloneProfileScope(previousScopes.claude)
  };
  nextScopes[scope] = cloneProfileScope(state);

  return {
    ...cloneRuntimeConfig(config),
    profiles: undefined,
    active_profile_id: nextScopes.codex?.active_profile_id ?? null,
    profile_scopes: nextScopes
  };
}

function cloneProfileScope(state: SavedConfigProfileScopeState | undefined): SavedConfigProfileScopeState {
  return {
    profiles: (state?.profiles ?? []).map(cloneProfile),
    active_profile_id: state?.active_profile_id ?? null
  };
}

function clearActiveProfileIds(scopes: SavedConfigProfileScopes | undefined): SavedConfigProfileScopes {
  return {
    codex: {
      profiles: (scopes?.codex?.profiles ?? []).map(cloneProfile),
      active_profile_id: null
    },
    claude: {
      profiles: (scopes?.claude?.profiles ?? []).map(cloneProfile),
      active_profile_id: null
    }
  };
}

function mergeProfileScopes(base: CompactGateConfig, patchRecord: Record<string, unknown>): SavedConfigProfileScopes {
  const baseScopes = base.profile_scopes;
  const legacyActive = readActiveProfileId(patchRecord.active_profile_id, base.active_profile_id ?? null);
  const legacySource = Array.isArray(patchRecord.profiles) ? patchRecord.profiles : base.profiles;
  const legacyMigration = migrateLegacyProfiles(legacySource, legacyActive);
  const patchScopes = readChild(patchRecord.profile_scopes);

  return {
    codex: mergeProfileScopeState(
      "codex",
      baseScopes?.codex,
      readChild(patchScopes.codex),
      legacyMigration.codexProfiles,
      legacyMigration.codexActiveProfileId
    ),
    claude: mergeProfileScopeState(
      "claude",
      baseScopes?.claude,
      readChild(patchScopes.claude),
      legacyMigration.claudeProfiles,
      legacyMigration.claudeActiveProfileId
    )
  };
}

function mergeProfileScopeState(
  scope: ConfigProfileScope,
  baseState: SavedConfigProfileScopeState | undefined,
  patchState: Record<string, unknown>,
  legacyProfiles: SavedConfigProfile[],
  legacyActive: string | null
): SavedConfigProfileScopeState {
  const baseProfiles = baseState?.profiles ?? [];
  const hasPatchProfiles = Array.isArray(patchState.profiles);
  const fallbackProfiles = legacyProfiles.length > 0 && baseProfiles.length === 0 ? legacyProfiles : baseProfiles;
  const fallbackActive = legacyProfiles.length > 0 && baseProfiles.length === 0
    ? legacyActive
    : baseState?.active_profile_id ?? null;
  return {
    profiles: hasPatchProfiles ? mergeProfiles(scope, fallbackProfiles, patchState.profiles) : fallbackProfiles.map(cloneProfile),
    active_profile_id: readActiveProfileId(patchState.active_profile_id, fallbackActive)
  };
}

function publicProfileScope(config: CompactGateConfig, scope: ConfigProfileScope) {
  const state = getProfileScopeState(config, scope);
  return {
    profiles: state.profiles.map((profile) => toPublicProfile(profile, scope)),
    active_profile_id: state.active_profile_id
  };
}

function mergeProfiles(
  scope: ConfigProfileScope,
  baseProfiles: SavedConfigProfile[],
  value: unknown
): SavedConfigProfile[] {
  if (!Array.isArray(value)) {
    return baseProfiles.map(cloneProfile);
  }

  return value
    .map((item) => readProfile(item, scope))
    .filter((item): item is SavedConfigProfile => item !== null);
}

function migrateLegacyProfiles(
  value: unknown,
  activeProfileId: string | null
): {
  codexProfiles: SavedConfigProfile[];
  codexActiveProfileId: string | null;
  claudeProfiles: SavedConfigProfile[];
  claudeActiveProfileId: string | null;
} {
  if (!Array.isArray(value)) {
    return {
      codexProfiles: [],
      codexActiveProfileId: null,
      claudeProfiles: [],
      claudeActiveProfileId: null
    };
  }

  const codexProfiles = value
    .map((item) => readProfile(item, "codex"))
    .filter((item): item is SavedConfigProfile => item !== null);
  const claudeProfiles: SavedConfigProfile[] = [];
  const claudeConfigProfileIds = new Map<string, string>();
  let claudeActiveProfileId: string | null = null;

  for (const item of value) {
    const profile = readProfile(item, "claude");
    if (!profile) {
      continue;
    }

    const configKey = JSON.stringify(profile.config);
    const existingProfileId = claudeConfigProfileIds.get(configKey);
    if (existingProfileId) {
      if (profile.id === activeProfileId) {
        claudeActiveProfileId = existingProfileId;
      }
      continue;
    }

    claudeConfigProfileIds.set(configKey, profile.id);
    claudeProfiles.push(profile);
    if (profile.id === activeProfileId) {
      claudeActiveProfileId = profile.id;
    }
  }

  return {
    codexProfiles,
    codexActiveProfileId: activeProfileId && codexProfiles.some((profile) => profile.id === activeProfileId)
      ? activeProfileId
      : null,
    claudeProfiles,
    claudeActiveProfileId
  };
}

function readProfile(value: unknown, scope: ConfigProfileScope): SavedConfigProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value.id, "");
  const name = readString(value.name, "");
  if (!id || !name) {
    return null;
  }

  const config = extractScopedProfileConfig(mergeRuntimeConfig(DEFAULT_CONFIG, readChild(value.config)), scope);
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
    config: cloneProfileConfig(profile.config)
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

function toPublicProfile(profile: SavedConfigProfile, scope: ConfigProfileScope): PublicConfigProfile {
  const runtime = profileConfigToRuntime(profile.config);
  const codexProfile = scope === "codex";
  const storedApiKeys = codexProfile
    ? [runtime.primary.api_key, runtime.compact.api_key]
    : [runtime.claude.primary.api_key, runtime.claude.compact.api_key];

  return {
    id: profile.id,
    scope,
    name: profile.name,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    primary_host: codexProfile ? safeHost(runtime.primary.base_url) : null,
    compact_host: codexProfile ? safeHost(runtime.compact.base_url) : null,
    claude_primary_host: codexProfile ? null : safeHost(runtime.claude.primary.base_url),
    claude_compact_host: codexProfile ? null : safeHost(runtime.claude.compact.base_url),
    claude_primary_model_override: codexProfile ? null : runtime.claude.primary.model_override,
    claude_compact_model_override: codexProfile ? null : runtime.claude.compact.model_override,
    claude_model_map: codexProfile ? null : { ...runtime.claude.model_map },
    compact_upstream_mode: codexProfile ? runtime.compact.upstream_mode : null,
    claude_compact_upstream_mode: codexProfile ? null : runtime.claude.compact.upstream_mode,
    stored_api_key_count: storedApiKeys.filter(directApiKeyConfigured).length
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
