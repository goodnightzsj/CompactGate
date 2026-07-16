import type {
  CompactGateConfig,
  CompactGateRuntimeConfig,
  ConfigProfileScope,
  PublicRouteUrlPreset,
  RouteUrlPreset,
  RouteUrlPresetKind,
  SavedConfigProfileConfig,
  UpstreamConfig
} from "../shared/types.js";
import { ConfigError } from "./config-error.js";
import { isValidBaseUrl, safeHost } from "./config-url.js";

const ROUTE_URL_PRESET_KINDS: RouteUrlPresetKind[] = [
  "codex_primary",
  "codex_compact",
  "claude_primary",
  "claude_compact"
];
const MAX_ROUTE_URL_PRESETS_PER_KIND = 24;

type RouteUrlPresetEntry = Pick<RouteUrlPreset, "kind" | "base_url" | "api_key" | "api_key_env">;
type RouteConfigWithCredentialPreset = {
  base_url?: unknown;
  api_key?: unknown;
  api_key_env?: unknown;
  credential_preset_id?: unknown;
};

export function isRouteUrlPresetKind(value: string): value is RouteUrlPresetKind {
  return ROUTE_URL_PRESET_KINDS.includes(value as RouteUrlPresetKind);
}

export function routeUrlEntriesFromRuntime(config: CompactGateRuntimeConfig): RouteUrlPresetEntry[] {
  return [
    routeUrlEntry("codex_primary", config.primary),
    routeUrlEntry("codex_compact", config.compact),
    routeUrlEntry("claude_primary", config.claude.primary),
    routeUrlEntry("claude_compact", config.claude.compact)
  ];
}

export function routeUrlEntriesFromProfileConfig(
  config: SavedConfigProfileConfig,
  scope: ConfigProfileScope,
  profileConfigToRuntime: (config: SavedConfigProfileConfig) => CompactGateRuntimeConfig
): RouteUrlPresetEntry[] {
  const runtime = profileConfigToRuntime(config);
  if (scope === "codex") {
    return [
      routeUrlEntry("codex_primary", runtime.primary),
      routeUrlEntry("codex_compact", runtime.compact)
    ];
  }

  return [
    routeUrlEntry("claude_primary", runtime.claude.primary),
    routeUrlEntry("claude_compact", runtime.claude.compact)
  ];
}

export function publicRouteUrlPreset(preset: RouteUrlPreset): PublicRouteUrlPreset {
  return {
    id: preset.id,
    kind: preset.kind,
    base_url: preset.base_url,
    api_key_env: preset.api_key_env,
    stored_api_key: directApiKeyConfigured(preset.api_key),
    api_key_configured: directApiKeyConfigured(preset.api_key) || envApiKeyConfigured(preset.api_key_env),
    host: preset.host,
    created_at: preset.created_at,
    updated_at: preset.updated_at,
    usage_count: preset.usage_count
  };
}

export function applyRouteUrlCredentialPresetBindings(
  config: CompactGateConfig,
  patch: unknown
): unknown {
  if (!isRecord(patch)) {
    return patch;
  }

  return {
    ...patch,
    primary: applyCredentialPresetToRoutePatch(config, "codex_primary", readChild(patch.primary)),
    compact: applyCredentialPresetToRoutePatch(config, "codex_compact", readChild(patch.compact)),
    claude: applyClaudeCredentialPresetPatch(config, readChild(patch.claude))
  };
}

export function withRecordedRouteUrlPresets(
  config: CompactGateConfig,
  entries: RouteUrlPresetEntry[]
): CompactGateConfig {
  if (entries.length === 0) {
    return {
      ...config,
      route_url_presets: normalizeRouteUrlPresets((config.route_url_presets ?? []).map(cloneRouteUrlPreset))
    };
  }

  const now = new Date().toISOString();
  const presets = (config.route_url_presets ?? []).map(cloneRouteUrlPreset);
  const seen = new Set<string>();

  for (const entry of entries) {
    const kind = entry.kind;
    const baseUrl = entry.base_url.trim();
    if (!baseUrl) {
      continue;
    }
    const apiKey = entry.api_key.trim();
    const apiKeyEnv = entry.api_key_env.trim();

    if (!isRouteUrlPresetKind(kind)) {
      throw new ConfigError("route_url_presets.kind must be a known route URL preset kind.");
    }

    if (!isValidBaseUrl(baseUrl)) {
      throw new ConfigError(`route_url_presets.${kind}.base_url must be a valid http or https URL.`);
    }

    const key = routeUrlPresetKey(kind, baseUrl);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const existing = presets.find((preset) => routeUrlPresetKey(preset.kind, preset.base_url) === key);
    if (existing) {
      existing.base_url = baseUrl;
      existing.api_key = apiKey;
      existing.api_key_env = apiKeyEnv;
      existing.host = safeHost(baseUrl);
      existing.updated_at = now;
      existing.usage_count += 1;
      presets.splice(presets.indexOf(existing), 1);
      presets.push(existing);
      continue;
    }

    presets.push({
      id: createRouteUrlPresetId(kind, baseUrl),
      kind,
      base_url: baseUrl,
      api_key: apiKey,
      api_key_env: apiKeyEnv,
      host: safeHost(baseUrl),
      created_at: now,
      updated_at: now,
      usage_count: 1
    });
  }

  return {
    ...config,
    route_url_presets: normalizeRouteUrlPresets(presets)
  };
}

export function mergeRouteUrlPresets(
  baseValue: RouteUrlPreset[] | undefined,
  patchValue: unknown
): RouteUrlPreset[] {
  const source = Array.isArray(patchValue) ? patchValue : baseValue ?? [];
  return normalizeRouteUrlPresets(
    source
      .map(readRouteUrlPreset)
      .filter((preset): preset is RouteUrlPreset => preset !== null)
  );
}

export function cloneRouteUrlPreset(preset: RouteUrlPreset): RouteUrlPreset {
  return { ...preset };
}

function routeUrlEntry(
  kind: RouteUrlPresetKind,
  config: UpstreamConfig
): RouteUrlPresetEntry {
  return {
    kind,
    base_url: config.base_url,
    api_key: config.api_key,
    api_key_env: config.api_key_env
  };
}

function applyClaudeCredentialPresetPatch(
  config: CompactGateConfig,
  patch: Record<string, unknown>
): Record<string, unknown> {
  if (Object.keys(patch).length === 0) {
    return patch;
  }

  return {
    ...patch,
    primary: applyCredentialPresetToRoutePatch(config, "claude_primary", readChild(patch.primary)),
    compact: applyCredentialPresetToRoutePatch(config, "claude_compact", readChild(patch.compact))
  };
}

function applyCredentialPresetToRoutePatch(
  config: CompactGateConfig,
  kind: RouteUrlPresetKind,
  patch: RouteConfigWithCredentialPreset
): Record<string, unknown> {
  const presetId = readString(patch.credential_preset_id, "");
  if (!presetId) {
    return patch as Record<string, unknown>;
  }

  const preset = (config.route_url_presets ?? []).find((candidate) =>
    candidate.kind === kind && candidate.id === presetId
  );
  if (!preset) {
    throw new ConfigError(`${kind}.credential_preset_id must reference a saved URL preset.`);
  }

  const patchBaseUrl = readString(patch.base_url, "");
  if (patchBaseUrl && normalizeRouteUrl(patchBaseUrl) !== normalizeRouteUrl(preset.base_url)) {
    throw new ConfigError(`${kind}.credential_preset_id must match the selected base_url.`);
  }

  return {
    ...patch,
    base_url: patchBaseUrl || preset.base_url,
    ...(!Object.hasOwn(patch, "api_key") ? { api_key: preset.api_key } : {}),
    ...(!Object.hasOwn(patch, "api_key_env") ? { api_key_env: preset.api_key_env } : {})
  };
}

function readRouteUrlPreset(value: unknown): RouteUrlPreset | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = readString(value.kind, "");
  if (!isRouteUrlPresetKind(kind)) {
    return null;
  }

  const baseUrl = readString(value.base_url, "");
  if (!baseUrl || !isValidBaseUrl(baseUrl)) {
    return null;
  }

  const createdAt = readString(value.created_at, new Date(0).toISOString());
  const updatedAt = readString(value.updated_at, createdAt);
  const usageCount = readNumber(value.usage_count, 1);

  return {
    id: readString(value.id, createRouteUrlPresetId(kind, baseUrl)),
    kind,
    base_url: baseUrl,
    api_key: readString(value.api_key, ""),
    api_key_env: readString(value.api_key_env, ""),
    host: safeHost(baseUrl),
    created_at: createdAt,
    updated_at: updatedAt,
    usage_count: Number.isInteger(usageCount) && usageCount > 0 ? usageCount : 1
  };
}

function sortRouteUrlPresets(presets: RouteUrlPreset[]): RouteUrlPreset[] {
  return presets.map((preset, index) => ({ preset, index })).sort((left, right) => {
    const kindDelta = ROUTE_URL_PRESET_KINDS.indexOf(left.preset.kind) - ROUTE_URL_PRESET_KINDS.indexOf(right.preset.kind);
    if (kindDelta !== 0) {
      return kindDelta;
    }
    return right.preset.updated_at.localeCompare(left.preset.updated_at) ||
      right.index - left.index ||
      left.preset.base_url.localeCompare(right.preset.base_url);
  }).map(({ preset }) => preset);
}

function normalizeRouteUrlPresets(presets: RouteUrlPreset[]): RouteUrlPreset[] {
  const countsByKind = new Map<RouteUrlPresetKind, number>();
  const seen = new Set<string>();
  const normalized: RouteUrlPreset[] = [];

  for (const preset of sortRouteUrlPresets(presets)) {
    const key = routeUrlPresetKey(preset.kind, preset.base_url);
    if (seen.has(key)) {
      continue;
    }

    const count = countsByKind.get(preset.kind) ?? 0;
    if (count >= MAX_ROUTE_URL_PRESETS_PER_KIND) {
      continue;
    }

    seen.add(key);
    countsByKind.set(preset.kind, count + 1);
    normalized.push(preset);
  }

  return normalized;
}

function createRouteUrlPresetId(kind: RouteUrlPresetKind, baseUrl: string): string {
  const slug = baseUrl
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "url";
  return `${kind}-${slug}-${stableHash(baseUrl)}`;
}

function routeUrlPresetKey(kind: RouteUrlPresetKind, baseUrl: string): string {
  return `${kind}:${normalizeRouteUrl(baseUrl)}`;
}

function normalizeRouteUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

function stableHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readChild(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function directApiKeyConfigured(value: string): boolean {
  return value.trim().length > 0;
}

function envApiKeyConfigured(value: string): boolean {
  const envName = value.trim();
  return envName.length > 0 && typeof process.env[envName] === "string" && process.env[envName].length > 0;
}
