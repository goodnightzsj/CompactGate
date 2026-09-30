import { CLAUDE_SCENES } from "./config-defaults.js";
import { ConfigError, isRecord } from "./config-internals.js";

/** Check raw containers before normalization can mistake malformed input for omission. */
export function validateImportedConfigContainers(config: Record<string, unknown>): void {
  validateRuntimeContainers(config, "");
  readArray(config.route_url_presets, "route_url_presets");
  validateProfiles(config.profiles, "profiles");
  const scopes = readObject(config.profile_scopes, "profile_scopes");
  for (const scope of ["codex", "claude"] as const) {
    const field = `profile_scopes.${scope}`;
    const state = readObject(scopes[scope], field);
    validateProfiles(state.profiles, `${field}.profiles`);
  }
}

function validateRuntimeContainers(config: Record<string, unknown>, prefix: string): void {
  for (const route of ["primary", "compact"] as const) {
    validateRouteContainers(readObject(config[route], `${prefix}${route}`), `${prefix}${route}`);
  }
  for (const field of ["timeouts", "logging", "primary_failover"] as const) {
    readObject(config[field], `${prefix}${field}`);
  }
  const field = `${prefix}claude`;
  const claude = readObject(config.claude, field);
  // Legacy Claude configs put the connection directly under `claude`.
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
  readArray(route.api_keys, `${field}.api_keys`);
}

function validateProfiles(value: unknown, field: string): void {
  for (const [index, profile] of readArray(value, field).entries()) {
    // The existing strict profile reader owns entry and field validation.
    if (!isRecord(profile)) continue;
    const configField = `${field}[${index}].config`;
    const config = readObject(profile.config, configField);
    validateRuntimeContainers(config, `${configField}.`);
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
