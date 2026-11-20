import { CLAUDE_SCENES, DEFAULT_CONFIG } from "./config-defaults.js";
import { ConfigError, isRecord } from "./config-internals.js";

/** Check supplied values before normalization can mistake malformed input for omission. */
export function validateImportedConfigContainers(config: Record<string, unknown>): void {
  validateRuntimeContainers(config, "");
  validateScalars(config, { active_profile_id: null }, "");
  for (const [index, preset] of readArray(config.route_url_presets, "route_url_presets").entries()) {
    if (isRecord(preset)) validateScalars(preset, { id: "", kind: "", base_url: "", api_key: "", api_key_env: "",
      created_at: "", updated_at: "", usage_count: 1 }, `route_url_presets[${index}].`);
  }
  validateProfiles(config.profiles, "profiles");
  const scopes = readObject(config.profile_scopes, "profile_scopes");
  for (const scope of ["codex", "claude"] as const) {
    const field = `profile_scopes.${scope}`;
    const state = readObject(scopes[scope], field);
    validateProfiles(state.profiles, `${field}.profiles`);
  }
}

function validateRuntimeContainers(config: Record<string, unknown>, prefix: string): void {
  validateScalars(config, DEFAULT_CONFIG, prefix);
  for (const route of ["primary", "compact"] as const) {
    validateRouteContainers(readObject(config[route], `${prefix}${route}`), `${prefix}${route}`);
  }
  for (const field of ["timeouts", "logging", "primary_failover"] as const) {
    readObject(config[field], `${prefix}${field}`);
  }
  const field = `${prefix}claude`;
  const claude = readObject(config.claude, field);
  // Legacy Claude configs put the connection directly under `claude`.
  validateScalars(claude, DEFAULT_CONFIG.claude.primary, `${field}.`);
  validateRouteContainers(claude, field);
  for (const route of ["primary", "compact"] as const) {
    validateRouteContainers(readObject(claude[route], `${field}.${route}`), `${field}.${route}`);
  }
  readObject(claude.model_map, `${field}.model_map`);
  const scenes = readObject(claude.scene_map, `${field}.scene_map`);
  for (const scene of CLAUDE_SCENES) {
    readObject(scenes[scene], `${field}.scene_map.${scene}`);
  }
}

function validateRouteContainers(route: Record<string, unknown>, field: string): void {
  readObject(route.extra_headers, `${field}.extra_headers`);
  for (const [index, key] of readArray(route.api_keys, `${field}.api_keys`).entries()) {
    if (isRecord(key)) validateScalars(key, { id: "", label: "", api_key: "", enabled: true }, `${field}.api_keys[${index}].`);
  }
}

function validateProfiles(value: unknown, field: string): void {
  for (const [index, profile] of readArray(value, field).entries()) {
    // The existing strict profile reader owns entry and field validation.
    if (!isRecord(profile)) continue;
    validateScalars(profile, { id: "", name: "", created_at: "", updated_at: "" }, `${field}[${index}].`);
    const configField = `${field}[${index}].config`;
    const config = readObject(profile.config, configField);
    validateRuntimeContainers(config, `${configField}.`);
  }
}

function validateScalars(value: Record<string, unknown>, defaults: object, prefix: string): void {
  for (const [key, example] of Object.entries(defaults)) {
    const supplied = value[key];
    if (supplied === undefined || Array.isArray(example)) continue;
    if (isRecord(example)) {
      if (isRecord(supplied)) validateScalars(supplied, example, `${prefix}${key}.`);
    } else if (example === null ? supplied !== null && typeof supplied !== "string" : typeof supplied !== typeof example) {
      throw new ConfigError(`${prefix}${key} must be ${example === null ? "a string or null" : `a ${typeof example}`}.`);
    }
  }
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(`${field} must be a JSON object.`);
  return value;
}

function readArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${field} must be an array.`);
  return value;
}
