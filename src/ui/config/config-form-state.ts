import type { CompactGateConfig, PublicConfig } from "../../shared/types.js";
import { emptyClaudeModelMap, normalizeClaudeModelMap } from "./model-map.js";
import type { ConfigFormState } from "./types.js";

export function emptyForm(): ConfigFormState {
  return {
    codexPrimaryBaseUrl: "",
    codexPrimaryApiKey: "",
    clearCodexPrimaryApiKey: false,
    codexCompactBaseUrl: "",
    codexCompactApiKey: "",
    clearCodexCompactApiKey: false,
    claudePrimaryBaseUrl: "",
    claudePrimaryApiKey: "",
    clearClaudePrimaryApiKey: false,
    claudeModelMap: emptyClaudeModelMap(),
    claudeCompactBaseUrl: "",
    claudeCompactApiKey: "",
    clearClaudeCompactApiKey: false,
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
    codexCompactBaseUrl: config.compact.base_url,
    codexCompactApiKey: "",
    clearCodexCompactApiKey: false,
    claudePrimaryBaseUrl: config.claude.primary.base_url,
    claudePrimaryApiKey: "",
    clearClaudePrimaryApiKey: false,
    claudeModelMap: normalizeClaudeModelMap(config.claude.model_map),
    claudeCompactBaseUrl: config.claude.compact.base_url,
    claudeCompactApiKey: "",
    clearClaudeCompactApiKey: false,
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
    ...apiKeyPatch(form.codexPrimaryApiKey, form.clearCodexPrimaryApiKey)
  };
  const compact = {
    base_url: form.codexCompactBaseUrl,
    ...apiKeyPatch(form.codexCompactApiKey, form.clearCodexCompactApiKey),
    upstream_mode: form.upstreamMode,
    model_mode: form.modelMode,
    model_template: form.modelTemplate,
    model_override: form.modelOverride
  };
  const claude = {
    primary: {
      base_url: form.claudePrimaryBaseUrl,
      ...apiKeyPatch(form.claudePrimaryApiKey, form.clearClaudePrimaryApiKey),
      model_override: claudeModelMap.default
    },
    model_map: claudeModelMap,
    compact: {
      base_url: form.claudeCompactBaseUrl,
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
      base_url: form.codexPrimaryBaseUrl
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

  applyApiKeyDraft(next.primary, form.codexPrimaryApiKey, form.clearCodexPrimaryApiKey);
  applyApiKeyDraft(next.compact, form.codexCompactApiKey, form.clearCodexCompactApiKey);
  applyApiKeyDraft(next.claude.primary, form.claudePrimaryApiKey, form.clearClaudePrimaryApiKey);
  applyApiKeyDraft(next.claude.compact, form.claudeCompactApiKey, form.clearClaudeCompactApiKey);

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
    codexCompactBaseUrl: form.codexCompactBaseUrl,
    codexCompactApiKey: normalizedApiKey(form.codexCompactApiKey),
    clearCodexCompactApiKey: form.clearCodexCompactApiKey,
    claudePrimaryBaseUrl: form.claudePrimaryBaseUrl,
    claudePrimaryApiKey: normalizedApiKey(form.claudePrimaryApiKey),
    clearClaudePrimaryApiKey: form.clearClaudePrimaryApiKey,
    claudeModelMap: normalizeClaudeModelMap(form.claudeModelMap),
    claudeCompactBaseUrl: form.claudeCompactBaseUrl,
    claudeCompactApiKey: normalizedApiKey(form.claudeCompactApiKey),
    clearClaudeCompactApiKey: form.clearClaudeCompactApiKey,
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

function applyApiKeyDraft(
  target: CompactGateConfig["primary"] | CompactGateConfig["compact"],
  value: string,
  shouldClear: boolean
): void {
  if (shouldClear) {
    target.api_key = "";
    return;
  }

  const apiKey = normalizedApiKey(value);
  if (apiKey.length > 0) {
    target.api_key = apiKey;
  }
}

function normalizedApiKey(value: string): string {
  return value.trim();
}
