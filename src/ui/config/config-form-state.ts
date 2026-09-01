import type {
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig,
  RouteUrlPresetKind,
  UpstreamConfig
} from "../../shared/types.js";
import { emptyClaudeModelMap, normalizeClaudeModelMap } from "./model-map.js";
import type { ConfigFormState } from "./types.js";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * 1024 * 1024;

/**
 * The form fields a profile save for each scope actually persists, mirroring
 * `extractScopedProfileConfig` on the server: `primary` + `compact` for codex,
 * `claude` for claude. Everything outside the list — logging, failover, and the
 * other scope's routes — is only ever written by `PATCH /api/config`.
 */
const SCOPED_PROFILE_FORM_FIELDS: Record<ConfigProfileScope, ReadonlyArray<keyof ConfigFormState>> = {
  codex: [
    "codexPrimaryBaseUrl",
    "codexPrimaryApiKey",
    "clearCodexPrimaryApiKey",
    "codexPrimaryCredentialPresetId",
    "codexPrimaryUpstreamProtocol",
    // The key pool round-trips like everything else here: `extractScopedProfileConfig`
    // spreads the whole `primary` object, so a profile stores its pool, its strategy,
    // and its reserve. Leaving these out meant a switch kept the *previous* profile's
    // rows in the draft, the save bar stayed dirty forever because the dirty check
    // compares tails, and the next plain save forwarded the old ids with no secret —
    // `mergeApiKeys` resolves plaintext by id, so unknown ids collapsed to "" and the
    // activated profile's real credentials were replaced by empty entries.
    "codexPrimaryApiKeys",
    "codexPrimaryKeyStrategy",
    "codexPrimaryRotationOptOut",
    "codexPrimaryStickyReserveSeconds",
    "primaryModelOverride",
    "primaryReasoningEffort",
    "primaryStateDomainId",
    "codexCompactBaseUrl",
    "codexCompactApiKey",
    "clearCodexCompactApiKey",
    "codexCompactCredentialPresetId",
    "codexCompactUpstreamProtocol",
    "upstreamMode",
    "modelMode",
    "modelTemplate",
    "modelOverride"
  ],
  claude: [
    "claudePrimaryBaseUrl",
    "claudePrimaryApiKey",
    "clearClaudePrimaryApiKey",
    "claudePrimaryCredentialPresetId",
    "claudePrimaryUpstreamProtocol",
    "claudePrimaryApiKeys",
    "claudePrimaryKeyStrategy",
    "claudePrimaryRotationOptOut",
    "claudePrimaryStickyReserveSeconds",
    "claudeModelMap",
    "claudeCompactBaseUrl",
    "claudeCompactApiKey",
    "clearClaudeCompactApiKey",
    "claudeCompactCredentialPresetId",
    "claudeCompactUpstreamProtocol",
    "claudeCompactModelOverride",
    "claudeCompactUpstreamMode"
  ]
};

/**
 * Adopt the server's answer for the slice a profile save just persisted while
 * leaving every other draft field alone. Rebuilding the whole form from the
 * response would silently revert edits that save never carried.
 */
export function formAfterScopedProfileChange(
  draft: ConfigFormState,
  config: PublicConfig,
  scope: ConfigProfileScope
): ConfigFormState {
  const saved = formFromConfig(config);
  const next: Record<string, unknown> = { ...draft };
  for (const field of SCOPED_PROFILE_FORM_FIELDS[scope]) {
    next[field] = saved[field];
  }
  return next as ConfigFormState;
}

export function emptyForm(): ConfigFormState {
  return {
    codexPrimaryBaseUrl: "",
    codexPrimaryApiKey: "",
    clearCodexPrimaryApiKey: false,
    codexPrimaryCredentialPresetId: "",
    codexPrimaryUpstreamProtocol: "openai_responses",
    primaryModelOverride: "",
    primaryReasoningEffort: "",
    primaryStateDomainId: "",
    primaryStatePortability: "recover_on_error",
    codexPrimaryApiKeys: [],
    codexPrimaryKeyStrategy: "fill_first",
    codexPrimaryRotationOptOut: false,
    codexPrimaryStickyReserveSeconds: 0,
    codexCompactBaseUrl: "",
    codexCompactApiKey: "",
    clearCodexCompactApiKey: false,
    codexCompactCredentialPresetId: "",
    codexCompactUpstreamProtocol: "openai_responses",
    claudePrimaryBaseUrl: "",
    claudePrimaryApiKey: "",
    clearClaudePrimaryApiKey: false,
    claudePrimaryCredentialPresetId: "",
    claudePrimaryUpstreamProtocol: "anthropic_messages",
    claudePrimaryApiKeys: [],
    claudePrimaryKeyStrategy: "fill_first",
    claudePrimaryRotationOptOut: false,
    claudePrimaryStickyReserveSeconds: 0,
    claudeModelMap: emptyClaudeModelMap(),
    claudeCompactBaseUrl: "",
    claudeCompactApiKey: "",
    clearClaudeCompactApiKey: false,
    claudeCompactCredentialPresetId: "",
    claudeCompactUpstreamProtocol: "anthropic_messages",
    claudeCompactModelOverride: "",
    claudeCompactUpstreamMode: "primary",
    upstreamMode: "split",
    modelMode: "linked",
    modelTemplate: "{model}-openai-compact",
    modelOverride: "",
    autoSchedulePrimaryFailover: true,
    loggingPersistBody: false,
    loggingKeepRecent: 200,
    loggingCaptureDir: "",
    loggingCaptureBodyMaxMiB: 1,
    loggingCaptureDirMaxGiB: 20,
    loggingMaxDatabaseMiB: 1024
  };
}

export function formFromConfig(config: PublicConfig): ConfigFormState {
  return {
    codexPrimaryBaseUrl: config.primary.base_url,
    codexPrimaryApiKey: "",
    clearCodexPrimaryApiKey: false,
    codexPrimaryCredentialPresetId: "",
    codexPrimaryUpstreamProtocol: config.primary.upstream_protocol,
    primaryModelOverride: config.primary.model_override ?? "",
    primaryReasoningEffort: config.primary.reasoning_effort,
    primaryStateDomainId: config.primary.state_domain_id,
    // Pool entries keep their saved ids — the server merge matches on id to
    // inherit the stored plaintext, which the public config never returns.
    codexPrimaryApiKeys: (config.primary.api_keys ?? []).map((key) => ({
      id: key.id,
      label: key.label,
      apiKey: "",
      enabled: key.enabled,
      tail: key.tail
    })),
    codexPrimaryKeyStrategy: config.primary.key_strategy ?? "fill_first",
    codexPrimaryRotationOptOut: config.primary.rotation_opt_out,
    codexPrimaryStickyReserveSeconds: config.primary.sticky_reserve_seconds ?? 0,
    primaryStatePortability: config.primary_failover.state_portability,
    codexCompactBaseUrl: config.compact.base_url,
    codexCompactApiKey: "",
    clearCodexCompactApiKey: false,
    codexCompactCredentialPresetId: "",
    codexCompactUpstreamProtocol: config.compact.upstream_protocol,
    claudePrimaryBaseUrl: config.claude.primary.base_url,
    claudePrimaryApiKey: "",
    clearClaudePrimaryApiKey: false,
    claudePrimaryCredentialPresetId: "",
    claudePrimaryUpstreamProtocol: config.claude.primary.upstream_protocol,
    claudePrimaryApiKeys: (config.claude.primary.api_keys ?? []).map((key) => ({
      id: key.id,
      label: key.label,
      apiKey: "",
      enabled: key.enabled,
      tail: key.tail
    })),
    claudePrimaryKeyStrategy: config.claude.primary.key_strategy ?? "fill_first",
    claudePrimaryRotationOptOut: config.claude.primary.rotation_opt_out,
    claudePrimaryStickyReserveSeconds: config.claude.primary.sticky_reserve_seconds ?? 0,
    claudeModelMap: normalizeClaudeModelMap(config.claude.model_map),
    claudeCompactBaseUrl: config.claude.compact.base_url,
    claudeCompactApiKey: "",
    clearClaudeCompactApiKey: false,
    claudeCompactCredentialPresetId: "",
    claudeCompactUpstreamProtocol: config.claude.compact.upstream_protocol,
    claudeCompactModelOverride: config.claude.compact.model_override,
    claudeCompactUpstreamMode: readUpstreamMode(config.claude.compact.upstream_mode, "primary"),
    upstreamMode: readUpstreamMode(config.compact.upstream_mode, "split"),
    modelMode: config.compact.model_mode,
    modelTemplate: config.compact.model_template,
    modelOverride: config.compact.model_override,
    autoSchedulePrimaryFailover: config.primary_failover.auto_schedule,
    loggingPersistBody: config.logging.persist_body,
    loggingKeepRecent: config.logging.keep_recent,
    loggingCaptureDir: config.logging.capture_dir ?? "",
    loggingCaptureBodyMaxMiB: config.logging.capture_body_max_bytes / MEBIBYTE,
    loggingCaptureDirMaxGiB: config.logging.capture_dir_max_bytes / GIBIBYTE,
    loggingMaxDatabaseMiB: config.logging.max_database_bytes / MEBIBYTE
  };
}

export function formToPatch(form: ConfigFormState) {
  const claudeModelMap = normalizeClaudeModelMap(form.claudeModelMap);
  const primary = {
    base_url: form.codexPrimaryBaseUrl,
    ...credentialPresetPatch(form.codexPrimaryCredentialPresetId),
    ...apiKeyPatch(form.codexPrimaryApiKey, form.clearCodexPrimaryApiKey),
    model_override: form.primaryModelOverride,
    upstream_protocol: form.codexPrimaryUpstreamProtocol,
    reasoning_effort: form.primaryReasoningEffort,
    state_domain_id: form.primaryStateDomainId,
    key_strategy: form.codexPrimaryKeyStrategy,
    rotation_opt_out: form.codexPrimaryRotationOptOut,
    sticky_reserve_seconds: form.codexPrimaryStickyReserveSeconds,
    // A typed secret travels; an empty one means "keep the stored value", which
    // the server inherits by id. Deleting every row clears the pool outright.
    api_keys: form.codexPrimaryApiKeys.map((entry) => ({
      id: entry.id,
      label: entry.label,
      enabled: entry.enabled,
      ...(entry.apiKey.trim().length > 0 ? { api_key: entry.apiKey.trim() } : {})
    }))
  };
  const compact = {
    base_url: form.codexCompactBaseUrl,
    ...credentialPresetPatch(form.codexCompactCredentialPresetId),
    ...apiKeyPatch(form.codexCompactApiKey, form.clearCodexCompactApiKey),
    upstream_mode: form.upstreamMode,
    model_mode: form.modelMode,
    model_template: form.modelTemplate,
    model_override: form.modelOverride,
    upstream_protocol: form.codexCompactUpstreamProtocol
  };
  const claude = {
    primary: {
      base_url: form.claudePrimaryBaseUrl,
      ...credentialPresetPatch(form.claudePrimaryCredentialPresetId),
      ...apiKeyPatch(form.claudePrimaryApiKey, form.clearClaudePrimaryApiKey),
      model_override: claudeModelMap.default,
      upstream_protocol: form.claudePrimaryUpstreamProtocol,
      key_strategy: form.claudePrimaryKeyStrategy,
      rotation_opt_out: form.claudePrimaryRotationOptOut,
      sticky_reserve_seconds: form.claudePrimaryStickyReserveSeconds,
      api_keys: form.claudePrimaryApiKeys.map((entry) => ({
        id: entry.id,
        label: entry.label,
        enabled: entry.enabled,
        ...(entry.apiKey.trim().length > 0 ? { api_key: entry.apiKey.trim() } : {})
      }))
    },
    model_map: claudeModelMap,
    compact: {
      base_url: form.claudeCompactBaseUrl,
      ...credentialPresetPatch(form.claudeCompactCredentialPresetId),
      ...apiKeyPatch(form.claudeCompactApiKey, form.clearClaudeCompactApiKey),
      upstream_mode: form.claudeCompactUpstreamMode,
      model_override: form.claudeCompactModelOverride,
      upstream_protocol: form.claudeCompactUpstreamProtocol
    }
  };

  return {
    primary,
    compact,
    claude,
    primary_failover: {
      auto_schedule: form.autoSchedulePrimaryFailover,
      state_portability: form.primaryStatePortability
    },
    logging: {
      persist_body: form.loggingPersistBody,
      keep_recent: boundedKeepRecent(form.loggingKeepRecent),
      capture_dir: normalizedCaptureDir(form.loggingCaptureDir),
      capture_body_max_bytes: bytesFromUnit(form.loggingCaptureBodyMaxMiB, MEBIBYTE),
      capture_dir_max_bytes: bytesFromUnit(form.loggingCaptureDirMaxGiB, GIBIBYTE),
      max_database_bytes: bytesFromUnit(form.loggingMaxDatabaseMiB, MEBIBYTE)
    }
  };
}

export function isFormDirty(config: PublicConfig, form: ConfigFormState): boolean {
  const current = draftComparisonState(formFromConfig(config));
  const draft = draftComparisonState(form);
  return JSON.stringify(current) !== JSON.stringify(draft);
}

export function applyDraftToConfigExport(
  config: CompactGateConfig,
  form: ConfigFormState
): CompactGateConfig {
  const claudeModelMap = normalizeClaudeModelMap(form.claudeModelMap);
  const next: CompactGateConfig = {
    listen: config.listen,
    primary: {
      ...config.primary,
      base_url: form.codexPrimaryBaseUrl,
      upstream_protocol: form.codexPrimaryUpstreamProtocol,
      model_override: form.primaryModelOverride,
      reasoning_effort: form.primaryReasoningEffort,
      state_domain_id: form.primaryStateDomainId,
      key_strategy: form.codexPrimaryKeyStrategy,
      rotation_opt_out: form.codexPrimaryRotationOptOut,
      sticky_reserve_seconds: form.codexPrimaryStickyReserveSeconds,
      api_keys: form.codexPrimaryApiKeys.map((entry) => {
        // The export baseline is the full plaintext config, so an untouched
        // entry keeps its stored secret here — unlike the patch path, which has
        // to inherit by id on the server.
        const stored = config.primary.api_keys?.find((candidate) => candidate.id === entry.id);
        return {
          id: entry.id,
          label: entry.label,
          api_key: entry.apiKey.trim().length > 0 ? entry.apiKey.trim() : stored?.api_key ?? "",
          enabled: entry.enabled
        };
      })
    },
    compact: {
      ...config.compact,
      base_url: form.codexCompactBaseUrl,
      upstream_protocol: form.codexCompactUpstreamProtocol,
      upstream_mode: form.upstreamMode,
      model_mode: form.modelMode,
      model_template: form.modelTemplate,
      model_override: form.modelOverride
    },
    claude: {
      primary: {
        ...config.claude.primary,
        base_url: form.claudePrimaryBaseUrl,
        upstream_protocol: form.claudePrimaryUpstreamProtocol,
        model_override: claudeModelMap.default,
        key_strategy: form.claudePrimaryKeyStrategy,
        rotation_opt_out: form.claudePrimaryRotationOptOut,
        sticky_reserve_seconds: form.claudePrimaryStickyReserveSeconds,
        api_keys: form.claudePrimaryApiKeys.map((entry) => {
          const stored = config.claude.primary.api_keys?.find((candidate) => candidate.id === entry.id);
          return {
            id: entry.id,
            label: entry.label,
            api_key: entry.apiKey.trim().length > 0 ? entry.apiKey.trim() : stored?.api_key ?? "",
            enabled: entry.enabled
          };
        })
      },
      compact: {
        ...config.claude.compact,
        base_url: form.claudeCompactBaseUrl,
        upstream_protocol: form.claudeCompactUpstreamProtocol,
        upstream_mode: form.claudeCompactUpstreamMode,
        model_override: form.claudeCompactModelOverride
      },
      model_map: claudeModelMap,
      scene_map: JSON.parse(JSON.stringify(config.claude.scene_map)),
      long_context_bytes: config.claude.long_context_bytes
    },
    timeouts: { ...config.timeouts },
    logging: {
      redact_body: config.logging.redact_body,
      persist_body: form.loggingPersistBody,
      // Falls back to the saved value where the patch path omits the key: an
      // export is a complete config, and writing the blank box through as 0 or
      // 1 byte produced a file CompactGate's own import then rejects.
      keep_recent: boundedKeepRecent(form.loggingKeepRecent) ?? config.logging.keep_recent,
      capture_dir: normalizedCaptureDir(form.loggingCaptureDir),
      capture_body_max_bytes: bytesFromUnit(form.loggingCaptureBodyMaxMiB, MEBIBYTE)
        ?? config.logging.capture_body_max_bytes,
      capture_dir_max_bytes: bytesFromUnit(form.loggingCaptureDirMaxGiB, GIBIBYTE)
        ?? config.logging.capture_dir_max_bytes,
      max_database_bytes: bytesFromUnit(form.loggingMaxDatabaseMiB, MEBIBYTE)
        ?? config.logging.max_database_bytes
    },
    primary_failover: {
      auto_schedule: form.autoSchedulePrimaryFailover,
      state_portability: form.primaryStatePortability
    },
    profiles: config.profiles,
    active_profile_id: config.active_profile_id,
    profile_scopes: config.profile_scopes,
    route_url_presets: config.route_url_presets
  };

  applyApiKeyDraft(
    next.primary,
    form.codexPrimaryApiKey,
    form.clearCodexPrimaryApiKey,
    config.route_url_presets,
    form.codexPrimaryCredentialPresetId,
    "codex_primary"
  );
  applyApiKeyDraft(
    next.compact,
    form.codexCompactApiKey,
    form.clearCodexCompactApiKey,
    config.route_url_presets,
    form.codexCompactCredentialPresetId,
    "codex_compact"
  );
  applyApiKeyDraft(
    next.claude.primary,
    form.claudePrimaryApiKey,
    form.clearClaudePrimaryApiKey,
    config.route_url_presets,
    form.claudePrimaryCredentialPresetId,
    "claude_primary"
  );
  applyApiKeyDraft(
    next.claude.compact,
    form.claudeCompactApiKey,
    form.clearClaudeCompactApiKey,
    config.route_url_presets,
    form.claudeCompactCredentialPresetId,
    "claude_compact"
  );

  return next;
}

export function renderLinkedModel(model: string, template: string): string {
  return template.replaceAll("{model}", model || "model");
}

function readUpstreamMode(value: unknown, fallback: "split" | "primary"): "split" | "primary" {
  return value === "split" || value === "primary" ? value : fallback;
}

function draftComparisonState(form: ConfigFormState) {
  return {
    codexPrimaryBaseUrl: form.codexPrimaryBaseUrl,
    codexPrimaryApiKey: normalizedApiKey(form.codexPrimaryApiKey),
    clearCodexPrimaryApiKey: form.clearCodexPrimaryApiKey,
    codexPrimaryCredentialPresetId: form.codexPrimaryCredentialPresetId,
    codexPrimaryUpstreamProtocol: form.codexPrimaryUpstreamProtocol,
    primaryModelOverride: form.primaryModelOverride,
    primaryReasoningEffort: form.primaryReasoningEffort,
    primaryStateDomainId: form.primaryStateDomainId,
    primaryStatePortability: form.primaryStatePortability,
    codexPrimaryApiKeys: form.codexPrimaryApiKeys.map((entry) => [
      entry.id,
      entry.label,
      entry.apiKey,
      entry.enabled,
      entry.tail
    ]),
    codexPrimaryKeyStrategy: form.codexPrimaryKeyStrategy,
    codexPrimaryRotationOptOut: form.codexPrimaryRotationOptOut,
    codexPrimaryStickyReserveSeconds: form.codexPrimaryStickyReserveSeconds,
    codexCompactBaseUrl: form.codexCompactBaseUrl,
    codexCompactApiKey: normalizedApiKey(form.codexCompactApiKey),
    clearCodexCompactApiKey: form.clearCodexCompactApiKey,
    codexCompactCredentialPresetId: form.codexCompactCredentialPresetId,
    codexCompactUpstreamProtocol: form.codexCompactUpstreamProtocol,
    claudePrimaryBaseUrl: form.claudePrimaryBaseUrl,
    claudePrimaryApiKey: normalizedApiKey(form.claudePrimaryApiKey),
    clearClaudePrimaryApiKey: form.clearClaudePrimaryApiKey,
    claudePrimaryCredentialPresetId: form.claudePrimaryCredentialPresetId,
    claudePrimaryUpstreamProtocol: form.claudePrimaryUpstreamProtocol,
    claudePrimaryApiKeys: form.claudePrimaryApiKeys.map((entry) => [
      entry.id,
      entry.label,
      entry.apiKey,
      entry.enabled,
      entry.tail
    ]),
    claudePrimaryKeyStrategy: form.claudePrimaryKeyStrategy,
    claudePrimaryRotationOptOut: form.claudePrimaryRotationOptOut,
    claudePrimaryStickyReserveSeconds: form.claudePrimaryStickyReserveSeconds,
    claudeModelMap: normalizeClaudeModelMap(form.claudeModelMap),
    claudeCompactBaseUrl: form.claudeCompactBaseUrl,
    claudeCompactApiKey: normalizedApiKey(form.claudeCompactApiKey),
    clearClaudeCompactApiKey: form.clearClaudeCompactApiKey,
    claudeCompactCredentialPresetId: form.claudeCompactCredentialPresetId,
    claudeCompactUpstreamProtocol: form.claudeCompactUpstreamProtocol,
    claudeCompactModelOverride: form.claudeCompactModelOverride,
    claudeCompactUpstreamMode: form.claudeCompactUpstreamMode,
    upstreamMode: form.upstreamMode,
    modelMode: form.modelMode,
    modelTemplate: form.modelTemplate,
    modelOverride: form.modelOverride,
    autoSchedulePrimaryFailover: form.autoSchedulePrimaryFailover,
    loggingPersistBody: form.loggingPersistBody,
    loggingKeepRecent: form.loggingKeepRecent,
    loggingCaptureDir: normalizedCaptureDir(form.loggingCaptureDir),
    loggingCaptureBodyMaxMiB: form.loggingCaptureBodyMaxMiB,
    loggingCaptureDirMaxGiB: form.loggingCaptureDirMaxGiB,
    loggingMaxDatabaseMiB: form.loggingMaxDatabaseMiB
  };
}

function apiKeyPatch(value: string, shouldClear: boolean): { api_key?: string } {
  if (shouldClear) {
    return { api_key: "" };
  }

  const apiKey = normalizedApiKey(value);
  return apiKey.length > 0 ? { api_key: apiKey } : {};
}

function credentialPresetPatch(value: string): { credential_preset_id?: string } {
  const presetId = value.trim();
  return presetId.length > 0 ? { credential_preset_id: presetId } : {};
}

function applyApiKeyDraft(
  target: UpstreamConfig,
  value: string,
  shouldClear: boolean,
  presets: CompactGateConfig["route_url_presets"],
  credentialPresetId: string,
  kind: RouteUrlPresetKind
): void {
  if (shouldClear) {
    target.api_key = "";
    return;
  }

  const apiKey = normalizedApiKey(value);
  if (apiKey.length > 0) {
    target.api_key = apiKey;
    return;
  }

  const preset = (presets ?? []).find((candidate) =>
    candidate.id === credentialPresetId && candidate.kind === kind && normalizeRouteUrl(candidate.base_url) === normalizeRouteUrl(target.base_url)
  );
  if (preset) {
    target.api_key = preset.api_key;
    target.api_key_env = preset.api_key_env;
  }
}

function normalizedApiKey(value: string): string {
  return value.trim();
}

function normalizedCaptureDir(value: string): string | null {
  const captureDir = value.trim();
  return captureDir.length > 0 ? captureDir : null;
}

/**
 * Omitted rather than clamped when the box holds no usable number.
 *
 * An emptied `<input type="number">` reads as `""` and `Number("")` is 0, which
 * the server rejects for every one of these limits — so sending it verbatim
 * would fail the *whole* PATCH over a field the operator was not editing. But
 * clamping to the legal floor was far worse than that: 1 byte passes validation,
 * and `RequestLogger.configure` then prunes the entire log history and capture
 * directory to honour it, reporting a successful save. Omitting the key means
 * "unchanged", which is what a blank box actually expresses. Deciding it here
 * rather than in the input keeps clear-and-retype working: forcing the minimum
 * into the box left a leading digit that silently multiplied the next keystroke.
 */
function bytesFromUnit(value: number, unitBytes: number): number | undefined {
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value * unitBytes))
    : undefined;
}

/**
 * Bounded at both ends, because the server rejects the whole patch outside 1—2000
 * and the box advertises `max="2000"` that nothing enforced: the page has no
 * `<form>`, so HTML5 constraint validation never runs. Clamping down to the
 * advertised ceiling honours "as many as possible" instead of discarding every
 * other edit in the draft along with it.
 */
function boundedKeepRecent(value: number): number | undefined {
  return Number.isFinite(value) && value >= 1
    ? Math.min(2_000, Math.round(value))
    : undefined;
}

function normalizeRouteUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}
