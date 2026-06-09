import type {
  CompactGateConfig,
  CompactGateRuntimeConfig,
  ConfigProfileScope,
  RouteUrlPreset,
  RouteUrlPresetKind,
  SavedConfigProfileConfig
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

type RouteUrlPresetEntry = Pick<RouteUrlPreset, "kind" | "base_url">;

export function isRouteUrlPresetKind(value: string): value is RouteUrlPresetKind {
  return ROUTE_URL_PRESET_KINDS.includes(value as RouteUrlPresetKind);
}

export function routeUrlEntriesFromRuntime(config: CompactGateRuntimeConfig): RouteUrlPresetEntry[] {
  return [
    { kind: "codex_primary", base_url: config.primary.base_url },
    { kind: "codex_compact", base_url: config.compact.base_url },
    { kind: "claude_primary", base_url: config.claude.primary.base_url },
    { kind: "claude_compact", base_url: config.claude.compact.base_url }
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
      { kind: "codex_primary", base_url: runtime.primary.base_url },
      { kind: "codex_compact", base_url: runtime.compact.base_url }
    ];
  }

  return [
    { kind: "claude_primary", base_url: runtime.claude.primary.base_url },
    { kind: "claude_compact", base_url: runtime.claude.compact.base_url }
  ];
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
