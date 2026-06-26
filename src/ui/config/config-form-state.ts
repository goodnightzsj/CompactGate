import type { CompactGateConfig, PublicConfig, RouteUrlPresetKind } from "../../shared/types.js";
import { emptyClaudeModelMap, normalizeClaudeModelMap } from "./model-map.js";
import type { ConfigFormState } from "./types.js";

export function emptyForm(): ConfigFormState {
  return {
    codexPrimaryBaseUrl: "",
    codexPrimaryApiKey: "",
    clearCodexPrimaryApiKey: false,
    codexPrimaryCredentialPresetId: "",
    primaryModelOverride: "",
    codexCompactBaseUrl: "",
    codexCompactApiKey: "",
    clearCodexCompactApiKey: false,
    codexCompactCredentialPresetId: "",
    claudePrimaryBaseUrl: "",
    claudePrimaryApiKey: "",
    clearClaudePrimaryApiKey: false,
    claudePrimaryCredentialPresetId: "",
    claudeModelMap: emptyClaudeModelMap(),
    claudeCompactBaseUrl: "",
    claudeCompactApiKey: "",
    clearClaudeCompactApiKey: false,
    claudeCompactCredentialPresetId: "",
    claudeCompactModelOverride: "",
    claudeCompactUpstreamMode: "primary",
    upstreamMode: "split",
    modelMode: "linked",
    modelTemplate: "{model}-openai-compact",
    modelOverride: "",
    autoSchedulePrimaryFailover: true
  };
}

export function formFromConfig(config: PublicConfig): ConfigFormState {
  return {
    codexPrimaryBaseUrl: config.primary.base_url,
    codexPrimaryApiKey: "",
    clearCodexPrimaryApiKey: false,
    codexPrimaryCredentialPresetId: "",
    primaryModelOverride: config.primary.model_override ?? "",
    codexCompactBaseUrl: config.compact.base_url,
    codexCompactApiKey: "",
    clearCodexCompactApiKey: false,
    codexCompactCredentialPresetId: "",
    claudePrimaryBaseUrl: config.claude.primary.base_url,
    claudePrimaryApiKey: "",
    clearClaudePrimaryApiKey: false,
    claudePrimaryCredentialPresetId: "",
    claudeModelMap: normalizeClaudeModelMap(config.claude.model_map),
    claudeCompactBaseUrl: config.claude.compact.base_url,
    claudeCompactApiKey: "",
    clearClaudeCompactApiKey: false,
    claudeCompactCredentialPresetId: "",
    claudeCompactModelOverride: config.claude.compact.model_override,
    claudeCompactUpstreamMode: readUpstreamMode(config.claude.compact.upstream_mode, "primary"),
    upstreamMode: readUpstreamMode(config.compact.upstream_mode, "split"),
    modelMode: config.compact.model_mode,
    modelTemplate: config.compact.model_template,
    modelOverride: config.compact.model_override,
    autoSchedulePrimaryFailover: config.primary_failover.auto_schedule
  };
}

export function formToPatch(form: ConfigFormState) {
  const claudeModelMap = normalizeClaudeModelMap(form.claudeModelMap);
  const primary = {
    base_url: form.codexPrimaryBaseUrl,
    ...credentialPresetPatch(form.codexPrimaryCredentialPresetId),
    ...apiKeyPatch(form.codexPrimaryApiKey, form.clearCodexPrimaryApiKey),
    model_override: form.primaryModelOverride
  };
  const compact = {
    base_url: form.codexCompactBaseUrl,
    ...credentialPresetPatch(form.codexCompactCredentialPresetId),
    ...apiKeyPatch(form.codexCompactApiKey, form.clearCodexCompactApiKey),
    upstream_mode: form.upstreamMode,
    model_mode: form.modelMode,
    model_template: form.modelTemplate,
    model_override: form.modelOverride
  };
  const claude = {
    primary: {
      base_url: form.claudePrimaryBaseUrl,
      ...credentialPresetPatch(form.claudePrimaryCredentialPresetId),
      ...apiKeyPatch(form.claudePrimaryApiKey, form.clearClaudePrimaryApiKey),
      model_override: claudeModelMap.default
    },
    model_map: claudeModelMap,
    compact: {
      base_url: form.claudeCompactBaseUrl,
      ...credentialPresetPatch(form.claudeCompactCredentialPresetId),
      ...apiKeyPatch(form.claudeCompactApiKey, form.clearClaudeCompactApiKey),
      upstream_mode: form.claudeCompactUpstreamMode,
      model_override: form.claudeCompactModelOverride
    }
  };

  return {
    primary,
    compact,
    claude,
    primary_failover: {
      auto_schedule: form.autoSchedulePrimaryFailover
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
      model_override: form.primaryModelOverride
    },
    compact: {
      ...config.compact,
      base_url: form.codexCompactBaseUrl,
      upstream_mode: form.upstreamMode,
      model_mode: form.modelMode,
      model_template: form.modelTemplate,
      model_override: form.modelOverride
    },
    claude: {
      primary: {
        ...config.claude.primary,
        base_url: form.claudePrimaryBaseUrl,
        model_override: claudeModelMap.default
      },
      compact: {
        ...config.claude.compact,
        base_url: form.claudeCompactBaseUrl,
        upstream_mode: form.claudeCompactUpstreamMode,
        model_override: form.claudeCompactModelOverride
      },
      model_map: claudeModelMap
    },
    timeouts: { ...config.timeouts },
    logging: { ...config.logging },
    primary_failover: {
      auto_schedule: form.autoSchedulePrimaryFailover
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
    primaryModelOverride: form.primaryModelOverride,
    codexCompactBaseUrl: form.codexCompactBaseUrl,
    codexCompactApiKey: normalizedApiKey(form.codexCompactApiKey),
    clearCodexCompactApiKey: form.clearCodexCompactApiKey,
    codexCompactCredentialPresetId: form.codexCompactCredentialPresetId,
    claudePrimaryBaseUrl: form.claudePrimaryBaseUrl,
    claudePrimaryApiKey: normalizedApiKey(form.claudePrimaryApiKey),
    clearClaudePrimaryApiKey: form.clearClaudePrimaryApiKey,
    claudePrimaryCredentialPresetId: form.claudePrimaryCredentialPresetId,
    claudeModelMap: normalizeClaudeModelMap(form.claudeModelMap),
    claudeCompactBaseUrl: form.claudeCompactBaseUrl,
    claudeCompactApiKey: normalizedApiKey(form.claudeCompactApiKey),
    clearClaudeCompactApiKey: form.clearClaudeCompactApiKey,
    claudeCompactCredentialPresetId: form.claudeCompactCredentialPresetId,
    claudeCompactModelOverride: form.claudeCompactModelOverride,
    claudeCompactUpstreamMode: form.claudeCompactUpstreamMode,
    upstreamMode: form.upstreamMode,
    modelMode: form.modelMode,
    modelTemplate: form.modelTemplate,
    modelOverride: form.modelOverride,
    autoSchedulePrimaryFailover: form.autoSchedulePrimaryFailover
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
  target: CompactGateConfig["primary"] | CompactGateConfig["compact"],
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

function normalizeRouteUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}
