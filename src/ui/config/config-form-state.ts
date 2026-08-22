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
    state_domain_id: form.primaryStateDomainId
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
      upstream_protocol: form.claudePrimaryUpstreamProtocol
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
      keep_recent: atLeast(form.loggingKeepRecent, 1),
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
      state_domain_id: form.primaryStateDomainId
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
        model_override: claudeModelMap.default
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
      keep_recent: form.loggingKeepRecent,
      capture_dir: normalizedCaptureDir(form.loggingCaptureDir),
      capture_body_max_bytes: bytesFromUnit(form.loggingCaptureBodyMaxMiB, MEBIBYTE),
      capture_dir_max_bytes: bytesFromUnit(form.loggingCaptureDirMaxGiB, GIBIBYTE),
      max_database_bytes: bytesFromUnit(form.loggingMaxDatabaseMiB, MEBIBYTE)
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

export function copyProfileRoutesToOtherDraft(
  form: ConfigFormState,
  profile: PublicConfig["profiles"][number]
): ConfigFormState {
  if (profile.scope === "codex") {
    return {
      ...form,
      claudePrimaryBaseUrl: profile.primary_base_url ?? form.claudePrimaryBaseUrl,
      claudePrimaryCredentialPresetId: "",
      claudePrimaryUpstreamProtocol:
        profile.primary_upstream_protocol ?? form.claudePrimaryUpstreamProtocol,
      claudeCompactBaseUrl: profile.compact_base_url ?? form.claudeCompactBaseUrl,
      claudeCompactCredentialPresetId: "",
      claudeCompactUpstreamProtocol:
        profile.compact_upstream_protocol ?? form.claudeCompactUpstreamProtocol,
      claudeCompactUpstreamMode:
        profile.compact_upstream_mode ?? form.claudeCompactUpstreamMode
    };
  }

  return {
    ...form,
    codexPrimaryBaseUrl: profile.claude_primary_base_url ?? form.codexPrimaryBaseUrl,
    codexPrimaryCredentialPresetId: "",
    codexPrimaryUpstreamProtocol:
      profile.claude_primary_upstream_protocol ?? form.codexPrimaryUpstreamProtocol,
    codexCompactBaseUrl: profile.claude_compact_base_url ?? form.codexCompactBaseUrl,
    codexCompactCredentialPresetId: "",
    codexCompactUpstreamProtocol:
      profile.claude_compact_upstream_protocol ?? form.codexCompactUpstreamProtocol,
    upstreamMode: profile.claude_compact_upstream_mode ?? form.upstreamMode
  };
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
 * Clamped, because an emptied `<input type="number">` reads as `""` and
 * `Number("")` is 0 — which the server rejects for every one of these limits, so
 * a momentarily blank box would fail the *whole* PATCH over a field the operator
 * was not editing. Clamping here rather than in the input keeps clear-and-retype
 * working: forcing the minimum into the box left a leading digit that silently
 * multiplied whatever was typed next.
 */
function bytesFromUnit(value: number, unitBytes: number): number {
  return Math.max(1, Math.round(atLeast(value, 0) * unitBytes));
}

function atLeast(value: number, minimum: number): number {
  return Number.isFinite(value) && value > minimum ? value : minimum;
}

function normalizeRouteUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}
