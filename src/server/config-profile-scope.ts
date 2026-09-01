import { hash } from "node:crypto";
import type {
  ClaudeCompactConfig,
  ClaudePrimaryConfig,
  CompactConfig,
  CompactGateConfig,
  CompactGateRuntimeConfig,
  ConfigProfileScope,
  PrimaryUpstreamConfig,
  SavedClaudeProfileConfig,
  SavedCodexProfileConfig,
  SavedConfigProfile,
  SavedConfigProfileConfig,
  SavedConfigProfileScopeState,
  SavedConfigProfileScopes
} from "../shared/types.js";
import {
  cloneProfile,
  cloneProfileConfig,
  cloneProfileScope,
  cloneRuntimeConfig,
  ConfigError,
  isRecord,
  readChild,
  readString
} from "./config-internals.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { cloneRouteUrlPreset } from "./config-route-presets.js";
import {
  mergeRuntimeConfig,
  validateRuntimeConfig
} from "./config-runtime.js";

const EPOCH_ISO = new Date(0).toISOString();

export function extractScopedProfileConfig(
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
      model_map: { ...runtime.claude.model_map },
      scene_map: structuredClone(runtime.claude.scene_map),
      long_context_bytes: runtime.claude.long_context_bytes
    }
  };
}

/**
 * Re-file a saved profile under the other scope, carrying the credential with it.
 *
 * Only the fields that keep their meaning across a scope change travel: where the
 * upstream is (`base_url`, `proxy_url`, `extra_headers`), what gets you in
 * (`api_key` and the whole `api_keys` pool), and how the pool is consumed
 * (`key_strategy`, `rotation_opt_out`, `sticky_reserve_seconds`, `upstream_mode`).
 * A relay that serves one scope almost always serves the other on the same host
 * and the same key, which is the case this exists for.
 *
 * Everything else resets to the destination scope's default, each for its own
 * reason: `upstream_protocol` because carrying it forces a lossy translation
 * where a native passthrough was available; `api_key_env` because the two scopes
 * name different variables; `model_override` and `model_map` because a model name
 * does not survive a change of provider family; and `reasoning_effort`,
 * `state_domain_id`, `model_mode`, `model_template`, `scene_map`,
 * `long_context_bytes` because they exist on one side only.
 *
 * Pool entry ids are kept as they are. Key health is tracked per
 * `profileId#keyId`, so a fresh profile id already separates the copy's
 * statistics from the source's; regenerating the key ids would only discard the
 * history the source built up.
 *
 * `from` and `to` must differ — a same-scope copy reproduces the stored config
 * verbatim and must not be routed through this reset.
 */
export function reScopeProfileConfig(
  config: SavedConfigProfileConfig,
  from: ConfigProfileScope,
  to: ConfigProfileScope
): SavedCodexProfileConfig | SavedClaudeProfileConfig {
  const source = profileConfigToRuntime(config);
  const sourceRoutes = from === "codex"
    ? { primary: source.primary, compact: source.compact }
    : { primary: source.claude.primary, compact: source.claude.compact };
  const target = cloneRuntimeConfig(DEFAULT_CONFIG);

  return extractScopedProfileConfig(
    to === "codex"
      ? {
          ...target,
          primary: { ...target.primary, ...carriedRouteFields(sourceRoutes.primary) },
          compact: {
            ...target.compact,
            ...carriedRouteFields(sourceRoutes.compact),
            upstream_mode: sourceRoutes.compact.upstream_mode
          }
        }
      : {
          ...target,
          claude: {
            ...target.claude,
            primary: { ...target.claude.primary, ...carriedRouteFields(sourceRoutes.primary) },
            compact: {
              ...target.claude.compact,
              ...carriedRouteFields(sourceRoutes.compact),
              upstream_mode: sourceRoutes.compact.upstream_mode
            }
          }
        },
    to
  );
}

function carriedRouteFields(route: PrimaryUpstreamConfig | CompactConfig | ClaudePrimaryConfig | ClaudeCompactConfig) {
  return {
    base_url: route.base_url,
    api_key: route.api_key,
    extra_headers: { ...route.extra_headers },
    proxy_url: route.proxy_url,
    // An absent pool must stay absent: materializing `api_keys: []` would read as
    // "the pool was cleared" and shadow the single `api_key` beside it.
    ...(route.api_keys && route.api_keys.length > 0
      ? { api_keys: route.api_keys.map((entry) => ({ ...entry })) }
      : {}),
    ...("key_strategy" in route ? { key_strategy: route.key_strategy } : {}),
    ...("rotation_opt_out" in route ? { rotation_opt_out: route.rotation_opt_out } : {}),
    ...("sticky_reserve_seconds" in route
      ? { sticky_reserve_seconds: route.sticky_reserve_seconds }
      : {})
  };
}

export function mergeProfileScopes(
  base: CompactGateConfig,
  patchRecord: Record<string, unknown>,
  strict = false
): SavedConfigProfileScopes {
  const baseScopes = base.profile_scopes;
  const patchScopes = readChild(patchRecord.profile_scopes);
  const legacy = migrateLegacyProfiles(base, patchRecord, strict);

  return {
    codex: mergeProfileScopeState(
      "codex",
      baseScopes?.codex,
      readChild(patchScopes.codex),
      legacy.codex,
      strict
    ),
    claude: mergeProfileScopeState(
      "claude",
      baseScopes?.claude,
      readChild(patchScopes.claude),
      legacy.claude,
      strict
    )
  };
}

function mergeProfileScopeState(
  scope: ConfigProfileScope,
  baseState: SavedConfigProfileScopeState | undefined,
  patchState: Record<string, unknown>,
  legacyState: SavedConfigProfileScopeState | null,
  strict: boolean
): SavedConfigProfileScopeState {
  // The migrated legacy list only stands in while this scope has nothing stored:
  // a source that already carries `profile_scopes` is authoritative, and an
  // omitted list means "unchanged", never "empty".
  const fallbackState = legacyState && (baseState?.profiles ?? []).length === 0
    ? legacyState
    : baseState;
  const baseProfiles = fallbackState?.profiles ?? [];
  // An empty list cannot erase the profiles that were just migrated either. A
  // document carrying both a legacy top-level `profiles` array and a present
  // but empty `profile_scopes` — a hand-edited file, or an export from the
  // transition — otherwise loaded as "no profiles at all", and the next write
  // persisted that, destroying every stored credential. Where there is nothing
  // to migrate this changes nothing, so an ordinary patch or import can still
  // clear the list.
  const patchProfiles = Array.isArray(patchState.profiles) ? patchState.profiles : null;
  const keepMigratedProfiles = patchProfiles !== null &&
    patchProfiles.length === 0 &&
    fallbackState === legacyState;
  return {
    profiles: patchProfiles !== null && !keepMigratedProfiles
      ? mergeProfiles(scope, baseProfiles, patchProfiles, strict)
      : baseProfiles.map(cloneProfile),
    active_profile_id: readActiveProfileId(
      patchState.active_profile_id,
      fallbackState?.active_profile_id ?? null
    )
  };
}

/**
 * Legacy configs — and exported backups written by that era — keep the whole
 * profile list at the top level with no `profile_scopes` at all. Reading only
 * `profile_scopes` loses every profile and credential in such a file, and the
 * next write persists the emptied list, so opening the file destroys it. A
 * top-level profile predates the scope split and therefore has no scope of its
 * own: it is a Codex profile unless its stored config carries nothing but the
 * `claude` section, which is the shape CompactGate wrote for Claude-only
 * profiles before the split landed.
 */
function migrateLegacyProfiles(
  base: CompactGateConfig,
  patchRecord: Record<string, unknown>,
  strict: boolean
): Record<ConfigProfileScope, SavedConfigProfileScopeState | null> {
  const source = Array.isArray(patchRecord.profiles) ? patchRecord.profiles : base.profiles;
  if (!Array.isArray(source) || source.length === 0) {
    return { codex: null, claude: null };
  }

  const activeProfileId = readActiveProfileId(
    patchRecord.active_profile_id,
    base.active_profile_id ?? null
  );
  const migrated: Record<ConfigProfileScope, SavedConfigProfile[]> = { codex: [], claude: [] };
  for (const item of source) {
    const scope = legacyProfileScope(item);
    const profile = readProfile(item, scope, null, strict);
    if (profile) {
      migrated[scope].push(profile);
    }
  }

  return {
    codex: legacyScopeState(migrated.codex, activeProfileId),
    claude: legacyScopeState(migrated.claude, activeProfileId)
  };
}

function legacyProfileScope(value: unknown): ConfigProfileScope {
  const config = readChild(readChild(value).config);
  return Object.hasOwn(config, "claude") &&
    !Object.hasOwn(config, "primary") &&
    !Object.hasOwn(config, "compact")
    ? "claude"
    : "codex";
}

function legacyScopeState(
  profiles: SavedConfigProfile[],
  activeProfileId: string | null
): SavedConfigProfileScopeState {
  return {
    profiles,
    active_profile_id: profiles.some((profile) => profile.id === activeProfileId)
      ? activeProfileId
      : null
  };
}

function mergeProfiles(
  scope: ConfigProfileScope,
  baseProfiles: SavedConfigProfile[],
  value: unknown[],
  strict: boolean
): SavedConfigProfile[] {
  const baseline = new Map(baseProfiles.map((profile) => [profile.id, profile]));
  return value
    .map((item) => readProfile(item, scope, baseline, strict))
    .filter((item): item is SavedConfigProfile => item !== null);
}

function readProfile(
  value: unknown,
  scope: ConfigProfileScope,
  baseline: Map<string, SavedConfigProfile> | null,
  strict: boolean
): SavedConfigProfile | null {
  if (!isRecord(value)) {
    return rejectProfile("profile must be a JSON object.", strict);
  }

  const id = readString(value.id, "");
  if (!id) {
    return rejectProfile("profile.id is required.", strict);
  }

  const existing = baseline?.get(id) ?? null;
  const name = readString(value.name, existing?.name ?? "");
  if (!name) {
    return rejectProfile("profile.name is required.", strict);
  }

  // "Omitted means unchanged", the same rule `route_url_presets` follows, and
  // here it is forced: `PublicConfigProfile` carries no `config` field at all, so
  // the ordinary GET /api/config → change one field → PATCH round trip restates
  // every profile by id, name and timestamps only. Rebuilding those on
  // DEFAULT_CONFIG kept the identity while resetting base_url, api_key,
  // state_domain_id, protocol and compact settings to the defaults — a 200 that
  // silently destroyed every stored credential. `importConfig` merges against
  // DEFAULT_CONFIG, where the baseline is empty, so a real import still replaces
  // the list outright.
  const config = extractScopedProfileConfig(
    mergeRuntimeConfig(
      existing ? profileConfigToRuntime(existing.config) : DEFAULT_CONFIG,
      readChild(value.config)
    ),
    scope
  );
  return {
    id,
    name,
    created_at: readString(value.created_at, existing?.created_at ?? EPOCH_ISO),
    updated_at: readString(value.updated_at, existing?.updated_at ?? EPOCH_ISO),
    config
  };
}

function rejectProfile(message: string, strict: boolean): null {
  // Dropping junk entries is deliberate on the patch path. An import replaces
  // the whole file and its preview already counted the entries, so a silent drop
  // there returns 200 while persisting fewer profiles than the user was shown.
  if (strict) {
    throw new ConfigError(message);
  }

  return null;
}

function readActiveProfileId(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }

  return typeof value === "string" ? value.trim() || null : fallback;
}

export function mergeRuntimeForProfileScope(
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
      model_map: { ...profileRuntime.claude.model_map },
      scene_map: structuredClone(profileRuntime.claude.scene_map),
      long_context_bytes: profileRuntime.claude.long_context_bytes
    }
  };
}

export function profileConfigToRuntime(config: SavedConfigProfileConfig): CompactGateRuntimeConfig {
  return mergeRuntimeConfig(DEFAULT_CONFIG, config);
}

export function validateProfileConfig(config: SavedConfigProfileConfig, scope: ConfigProfileScope): void {
  validateRuntimeConfig(profileConfigToRuntime(extractScopedProfileConfig(profileConfigToRuntime(config), scope)));
}

export function getProfileScopeState(
  config: CompactGateConfig,
  scope: ConfigProfileScope
): { profiles: SavedConfigProfile[]; active_profile_id: string | null } {
  const scoped = config.profile_scopes?.[scope];
  return {
    profiles: (scoped?.profiles ?? []).map(cloneProfile),
    active_profile_id: scoped?.active_profile_id ?? null
  };
}

export function withProfileScope(
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
    active_profile_id: nextScopes.codex?.active_profile_id ?? null,
    profile_scopes: nextScopes,
    route_url_presets: (config.route_url_presets ?? []).map(cloneRouteUrlPreset)
  };
}

export function syncActiveProfilesFromRuntime(
  config: CompactGateConfig,
  previous: CompactGateConfig
): CompactGateConfig {
  const now = new Date().toISOString();
  return syncActiveProfileScopeFromRuntime(
    syncActiveProfileScopeFromRuntime(config, previous, "codex", now),
    previous,
    "claude",
    now
  );
}

function syncActiveProfileScopeFromRuntime(
  config: CompactGateConfig,
  previous: CompactGateConfig,
  scope: ConfigProfileScope,
  updatedAt: string
): CompactGateConfig {
  const scopeState = getProfileScopeState(config, scope);
  const activeProfileId = scopeState.active_profile_id;
  if (!activeProfileId) {
    return withProfileScope(config, scope, {
      profiles: scopeState.profiles,
      active_profile_id: null
    });
  }

  // A patch that moves the pointer is a profile switch, not an edit of the
  // profile it lands on. Mirroring the runtime into the target would overwrite
  // the target's stored base_url and api_key with the ones belonging to the
  // profile being left — the switch would destroy the credentials it was meant
  // to activate. Apply the target instead, the same direction `applyProfile`
  // moves. While the pointer stays put the mirror is still right: a patch that
  // only touches runtime fields *is* an edit of the active profile.
  const target = scopeState.profiles.find((profile) => profile.id === activeProfileId);
  if (target && getProfileScopeState(previous, scope).active_profile_id !== activeProfileId) {
    return withProfileScope(
      { ...config, ...mergeRuntimeForProfileScope(config, target.config, scope) },
      scope,
      { profiles: scopeState.profiles, active_profile_id: activeProfileId }
    );
  }

  const runtimeProfileConfig = extractScopedProfileConfig(config, scope);
  validateProfileConfig(runtimeProfileConfig, scope);
  const profiles = scopeState.profiles.map((profile) =>
    profile.id === activeProfileId
      ? {
          ...profile,
          // Only a real change counts as an edit. Restamping on every patch made
          // an unrelated `logging.keep_recent` change age both scopes' active
          // profile cards to "just updated".
          updated_at: sameProfileConfig(profile.config, runtimeProfileConfig)
            ? profile.updated_at
            : updatedAt,
          config: cloneProfileConfig(runtimeProfileConfig)
        }
      : cloneProfile(profile)
  );

  return withProfileScope(config, scope, {
    profiles,
    active_profile_id: activeProfileId
  });
}

function sameProfileConfig(
  left: SavedConfigProfileConfig,
  right: SavedConfigProfileConfig
): boolean {
  // Both sides are produced by `extractScopedProfileConfig`, so the key order
  // matches and a string compare is enough. A false negative only costs a
  // spurious timestamp, which is what this replaces.
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createProfileId(name: string, isoTime: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "profile";
  // The slug is lossy — truncated at 40 characters and every run of
  // non-alphanumerics collapsed to one dash — so two different names can slug
  // identically, and two profiles created in the same millisecond then get the
  // same id. `validateConfig` rejects that as "ids must be unique", an error
  // pointing nowhere near the actual cause. Bind the id to the full name so
  // distinct names cannot collide.
  return `${slug}-${Date.parse(isoTime).toString(36)}-${hash("sha1", name, "hex").slice(0, 6)}`;
}
