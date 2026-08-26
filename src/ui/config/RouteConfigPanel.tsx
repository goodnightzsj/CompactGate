import type * as React from "react";
import type {
  ConfigProfileScope,
  PublicConfig,
  RouteUrlPresetKind
} from "../../shared/types.js";
import { profileScopeState } from "./profile-utils.js";
import {
  RouteCredentialFields,
  type RouteUrlSuggestion
} from "./RouteCredentialFields.js";
import type { ConfigFormState } from "./types.js";

type PublicRouteCredentialConfig =
  | PublicConfig["primary"]
  | PublicConfig["compact"]
  | PublicConfig["claude"]["primary"]
  | PublicConfig["claude"]["compact"];

export function RouteConfigPanel({
  config,
  form,
  onFormChange
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
}) {
  return (
    <div className="route-config-stack">
      <div className="config-row">
        <RouteCredentialFields
          title="Codex 主路由" badge="Codex" tone="primary"
          baseUrlLabel="基础地址" baseUrlHint="填写完整 API 根（如 /v1 或 /v4）；本地 /v1 会被替换。"
          apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Codex 主路由", config?.primary ?? null)}
          upstreamProtocol={form.codexPrimaryUpstreamProtocol}
          baseUrl={form.codexPrimaryBaseUrl} apiKey={form.codexPrimaryApiKey}
          storedApiKey={config?.primary.stored_api_key ?? false}
          clearApiKey={form.clearCodexPrimaryApiKey}
          routeUrlSuggestions={routeUrlSuggestions(config, "codex_primary")}
          onBaseUrlChange={(value) => onFormChange((previous) => ({
            ...previous,
            codexPrimaryBaseUrl: value,
            codexPrimaryCredentialPresetId: ""
          }))}
          onSuggestionSelect={(suggestion) => onFormChange((previous) => ({
            ...previous,
            codexPrimaryBaseUrl: suggestion.baseUrl,
            codexPrimaryCredentialPresetId: suggestion.credentialPresetId
          }))}
          onApiKeyChange={(value) => onFormChange((previous) => ({
            ...previous,
            codexPrimaryApiKey: value,
            clearCodexPrimaryApiKey: false,
            codexPrimaryCredentialPresetId: ""
          }))}
          onUpstreamProtocolChange={(codexPrimaryUpstreamProtocol) => onFormChange((previous) => ({
            ...previous,
            codexPrimaryUpstreamProtocol
          }))}
          onToggleClearApiKey={() => onFormChange((previous) => ({
            ...previous,
            codexPrimaryApiKey: "",
            clearCodexPrimaryApiKey: !previous.clearCodexPrimaryApiKey,
            codexPrimaryCredentialPresetId: ""
          }))}
          keyPool={form.codexPrimaryApiKeys}
          keyStrategy={form.codexPrimaryKeyStrategy}
          rotationOptOut={form.codexPrimaryRotationOptOut}
          stickyReserveSeconds={form.codexPrimaryStickyReserveSeconds}
          onKeyPoolChange={(codexPrimaryApiKeys) => onFormChange((previous) => ({ ...previous, codexPrimaryApiKeys }))}
          onKeyStrategyChange={(codexPrimaryKeyStrategy) => onFormChange((previous) => ({ ...previous, codexPrimaryKeyStrategy }))}
          onRotationOptOutChange={(codexPrimaryRotationOptOut) => onFormChange((previous) => ({ ...previous, codexPrimaryRotationOptOut }))}
          onStickyReserveChange={(codexPrimaryStickyReserveSeconds) => onFormChange((previous) => ({ ...previous, codexPrimaryStickyReserveSeconds }))}
        />
        <RouteCredentialFields
          title="Codex 压缩路由" badge="压缩" tone="compact"
          baseUrlLabel="基础地址" baseUrlHint={form.upstreamMode === "split" ? "填写完整 API 根；Local/Remote V1 走这里，Remote V2 仍走主路由。" : "Local/Remote V1 复用 Codex 主路由；Remote V2 始终走主路由。"}
          apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Codex 压缩路由", config?.compact ?? null)}
          upstreamProtocol={form.codexCompactUpstreamProtocol}
          baseUrl={form.codexCompactBaseUrl} apiKey={form.codexCompactApiKey}
          storedApiKey={config?.compact.stored_api_key ?? false}
          clearApiKey={form.clearCodexCompactApiKey}
          routeUrlSuggestions={routeUrlSuggestions(config, "codex_compact")}
          onBaseUrlChange={(value) => onFormChange((previous) => ({
            ...previous,
            codexCompactBaseUrl: value,
            codexCompactCredentialPresetId: ""
          }))}
          onSuggestionSelect={(suggestion) => onFormChange((previous) => ({
            ...previous,
            codexCompactBaseUrl: suggestion.baseUrl,
            codexCompactCredentialPresetId: suggestion.credentialPresetId
          }))}
          onApiKeyChange={(value) => onFormChange((previous) => ({
            ...previous,
            codexCompactApiKey: value,
            clearCodexCompactApiKey: false,
            codexCompactCredentialPresetId: ""
          }))}
          onUpstreamProtocolChange={(codexCompactUpstreamProtocol) => onFormChange((previous) => ({
            ...previous,
            codexCompactUpstreamProtocol
          }))}
          onToggleClearApiKey={() => onFormChange((previous) => ({
            ...previous,
            codexCompactApiKey: "",
            clearCodexCompactApiKey: !previous.clearCodexCompactApiKey,
            codexCompactCredentialPresetId: ""
          }))}
        />
      </div>
      <div className="config-row">
        <RouteCredentialFields
          title="Claude 主路由" badge="Claude" tone="claude"
          baseUrlLabel="基础地址" baseUrlHint="填写主机或供应商前缀；末尾 /v1 会自动避免重复。"
          apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Claude 主路由", config?.claude.primary ?? null)}
          upstreamProtocol={form.claudePrimaryUpstreamProtocol}
          baseUrl={form.claudePrimaryBaseUrl} apiKey={form.claudePrimaryApiKey}
          storedApiKey={config?.claude.primary.stored_api_key ?? false}
          clearApiKey={form.clearClaudePrimaryApiKey}
          routeUrlSuggestions={routeUrlSuggestions(config, "claude_primary")}
          onBaseUrlChange={(value) => onFormChange((previous) => ({
            ...previous,
            claudePrimaryBaseUrl: value,
            claudePrimaryCredentialPresetId: ""
          }))}
          onSuggestionSelect={(suggestion) => onFormChange((previous) => ({
            ...previous,
            claudePrimaryBaseUrl: suggestion.baseUrl,
            claudePrimaryCredentialPresetId: suggestion.credentialPresetId
          }))}
          onApiKeyChange={(value) => onFormChange((previous) => ({
            ...previous,
            claudePrimaryApiKey: value,
            clearClaudePrimaryApiKey: false,
            claudePrimaryCredentialPresetId: ""
          }))}
          onUpstreamProtocolChange={(claudePrimaryUpstreamProtocol) => onFormChange((previous) => ({
            ...previous,
            claudePrimaryUpstreamProtocol
          }))}
          onToggleClearApiKey={() => onFormChange((previous) => ({
            ...previous,
            claudePrimaryApiKey: "",
            clearClaudePrimaryApiKey: !previous.clearClaudePrimaryApiKey,
            claudePrimaryCredentialPresetId: ""
          }))}
          keyPool={form.claudePrimaryApiKeys}
          keyStrategy={form.claudePrimaryKeyStrategy}
          rotationOptOut={form.claudePrimaryRotationOptOut}
          stickyReserveSeconds={form.claudePrimaryStickyReserveSeconds}
          onKeyPoolChange={(claudePrimaryApiKeys) => onFormChange((previous) => ({ ...previous, claudePrimaryApiKeys }))}
          onKeyStrategyChange={(claudePrimaryKeyStrategy) => onFormChange((previous) => ({ ...previous, claudePrimaryKeyStrategy }))}
          onRotationOptOutChange={(claudePrimaryRotationOptOut) => onFormChange((previous) => ({ ...previous, claudePrimaryRotationOptOut }))}
          onStickyReserveChange={(claudePrimaryStickyReserveSeconds) => onFormChange((previous) => ({ ...previous, claudePrimaryStickyReserveSeconds }))}
        />
        <RouteCredentialFields
          title="Claude 压缩路由" badge="压缩" tone="claude"
          baseUrlLabel="基础地址" baseUrlHint={form.claudeCompactUpstreamMode === "split" ? "填写压缩上游的主机或 API 根。" : "复用 Claude 主路由；切换为独立分流后使用这里的地址。"}
          apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Claude 压缩路由", config?.claude.compact ?? null)}
          upstreamProtocol={form.claudeCompactUpstreamProtocol}
          baseUrl={form.claudeCompactBaseUrl} apiKey={form.claudeCompactApiKey}
          storedApiKey={config?.claude.compact.stored_api_key ?? false}
          clearApiKey={form.clearClaudeCompactApiKey}
          routeUrlSuggestions={routeUrlSuggestions(config, "claude_compact")}
          onBaseUrlChange={(value) => onFormChange((previous) => ({
            ...previous,
            claudeCompactBaseUrl: value,
            claudeCompactCredentialPresetId: ""
          }))}
          onSuggestionSelect={(suggestion) => onFormChange((previous) => ({
            ...previous,
            claudeCompactBaseUrl: suggestion.baseUrl,
            claudeCompactCredentialPresetId: suggestion.credentialPresetId
          }))}
          onApiKeyChange={(value) => onFormChange((previous) => ({
            ...previous,
            claudeCompactApiKey: value,
            clearClaudeCompactApiKey: false,
            claudeCompactCredentialPresetId: ""
          }))}
          onUpstreamProtocolChange={(claudeCompactUpstreamProtocol) => onFormChange((previous) => ({
            ...previous,
            claudeCompactUpstreamProtocol
          }))}
          onToggleClearApiKey={() => onFormChange((previous) => ({
            ...previous,
            claudeCompactApiKey: "",
            clearClaudeCompactApiKey: !previous.clearClaudeCompactApiKey,
            claudeCompactCredentialPresetId: ""
          }))}
        />
      </div>
      <div className="route-config-stack route-config-stack-narrow">
        <div className="config-row">
          <label className="field" htmlFor="primary-state-domain-id">
            <span className="field-label">Codex 状态域</span>
            <input
              id="primary-state-domain-id"
              value={form.primaryStateDomainId}
              placeholder="留空时按 profile 隔离"
              onChange={(event) => onFormChange((previous) => ({
                ...previous,
                primaryStateDomainId: event.target.value
              }))}
            />
          </label>
          <div className="field">
            <span className="field-label">旧会话切换策略</span>
            <div className="toggle-group" role="group" aria-label="旧会话切换策略">
              {([
                ["off", "关闭"],
                ["recover_on_error", "出错后恢复"]
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={form.primaryStatePortability === value ? "is-active" : ""}
                  onClick={() => onFormChange((previous) => ({
                    ...previous,
                    primaryStatePortability: value
                  }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="config-row">
          <div>
            <div className="field-label field-label-block">Codex 压缩上游模式</div>
            <div className="toggle-group" role="group" aria-label="Codex 压缩上游模式">
              <button type="button" className={form.upstreamMode === "split" ? "is-active" : ""} onClick={() => onFormChange((previous) => ({ ...previous, upstreamMode: "split" }))}>独立分流</button>
              <button type="button" className={form.upstreamMode === "primary" ? "is-active" : ""} onClick={() => onFormChange((previous) => ({ ...previous, upstreamMode: "primary" }))}>复用主路由</button>
            </div>
          </div>
          <div>
            <div className="field-label field-label-block">Claude 压缩上游模式</div>
            <div className="toggle-group" role="group" aria-label="Claude 压缩上游模式">
              <button type="button" className={form.claudeCompactUpstreamMode === "split" ? "is-active" : ""} onClick={() => onFormChange((previous) => ({ ...previous, claudeCompactUpstreamMode: "split" }))}>独立分流</button>
              <button type="button" className={form.claudeCompactUpstreamMode === "primary" ? "is-active" : ""} onClick={() => onFormChange((previous) => ({ ...previous, claudeCompactUpstreamMode: "primary" }))}>复用主路由</button>
            </div>
          </div>
        </div>
        <section className="auto-schedule-card" aria-labelledby="auto-schedule-title">
          <div className="auto-schedule-copy">
            <span className="profile-item-kicker">主路由保护</span>
            <h3 id="auto-schedule-title">错误自动调度</h3>
            <p>
              开启后，Codex 主路由同类错误超过 10 次才会自动调度到下一个账号，并同步当前运行时档案。
            </p>
          </div>
          <label className="auto-schedule-switch">
            <input
              type="checkbox"
              checked={form.autoSchedulePrimaryFailover}
              onChange={(event) => onFormChange((previous) => ({
                ...previous,
                autoSchedulePrimaryFailover: event.target.checked
              }))}
            />
            <span className="auto-schedule-track" aria-hidden="true">
              <span className="auto-schedule-thumb" />
            </span>
            <span>{form.autoSchedulePrimaryFailover ? "已开启" : "已关闭"}</span>
          </label>
        </section>
      </div>
    </div>
  );
}

function directApiKeyHint(
  routeLabelText: string,
  upstream?: PublicRouteCredentialConfig | null
): string {
  if (!upstream) {
    return "保存后会直接写入 compactgate.json。";
  }

  if (upstream.stored_api_key) {
    return "这个槽位已经保存过直填密钥。留空保持现状，输入新值后会直接覆盖。";
  }

  if (upstream.api_key_source === "env") {
    return `当前仍在回退环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。留空保持回退，输入新值后会改为直填密钥。`;
  }

  return `当前还没有 ${routeLabelText} 密钥；保存后会直接写入 compactgate.json。`;
}

export function routeUrlSuggestions(
  config: PublicConfig | null,
  kind: RouteUrlPresetKind
): RouteUrlSuggestion[] {
  if (!config) {
    return [];
  }

  const scope: ConfigProfileScope = kind.startsWith("claude_") ? "claude" : "codex";
  const profiles = profileScopeState(config, scope).profiles;
  const seen = new Set<string>();
  const suggestions: RouteUrlSuggestion[] = [];

  for (const preset of config.route_url_presets) {
    if (preset.kind !== kind) {
      continue;
    }

    const key = normalizeUrlSuggestionKey(preset.base_url);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    suggestions.push({
      baseUrl: preset.base_url,
      credentialPresetId: preset.id,
      apiKeyEnv: preset.api_key_env ?? "",
      storedApiKey: preset.stored_api_key ?? false,
      apiKeyConfigured: preset.api_key_configured ?? false,
      host: preset.host || hostLabel(preset.base_url),
      label: `已保存 ${preset.usage_count} 次`,
      updatedAt: preset.updated_at
    });
  }

  for (const profile of profiles) {
    const baseUrl = profileUrlForKind(profile, kind);
    if (!baseUrl) {
      continue;
    }

    const key = normalizeUrlSuggestionKey(baseUrl);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    suggestions.push({
      baseUrl,
      credentialPresetId: "",
      apiKeyEnv: "",
      storedApiKey: false,
      apiKeyConfigured: false,
      host: hostLabel(baseUrl),
      label: `档案：${profile.name}`,
      updatedAt: profile.updated_at
    });
  }

  return suggestions;
}

function profileUrlForKind(
  profile: PublicConfig["profiles"][number],
  kind: RouteUrlPresetKind
): string | null {
  if (kind === "codex_primary") {
    return profile.primary_base_url;
  }

  if (kind === "codex_compact") {
    return profile.compact_base_url;
  }

  if (kind === "claude_primary") {
    return profile.claude_primary_base_url;
  }

  return profile.claude_compact_base_url;
}

function normalizeUrlSuggestionKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString().replace(/\/+$/g, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/g, "").toLowerCase();
  }
}

function hostLabel(value: string | null): string {
  if (!value || !value.trim()) {
    return "默认或未声明";
  }

  try {
    return new URL(value).host;
  } catch {
    return "无效 URL";
  }
}
