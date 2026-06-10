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
    <div style={{ display: "grid", gap: 14 }}>
      <div className="config-row">
        <RouteCredentialFields
          title="Codex 主路由" badge="Codex" tone="primary"
          baseUrlLabel="基础地址" baseUrlHint="普通 /v1 请求会转发到这里。"
          apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Codex 主路由", config?.primary ?? null)}
          baseUrl={form.codexPrimaryBaseUrl} apiKey={form.codexPrimaryApiKey}
          storedApiKey={config?.primary.stored_api_key ?? false}
          clearApiKey={form.clearCodexPrimaryApiKey}
          routeUrlSuggestions={routeUrlSuggestions(config, "codex_primary")}
          onBaseUrlChange={(value) => onFormChange((previous) => ({ ...previous, codexPrimaryBaseUrl: value }))}
          onApiKeyChange={(value) => onFormChange((previous) => ({ ...previous, codexPrimaryApiKey: value, clearCodexPrimaryApiKey: false }))}
          onToggleClearApiKey={() => onFormChange((previous) => ({ ...previous, codexPrimaryApiKey: "", clearCodexPrimaryApiKey: !previous.clearCodexPrimaryApiKey }))}
        />
        <RouteCredentialFields
          title="Codex 压缩路由" badge="压缩" tone="compact"
          baseUrlLabel="基础地址" baseUrlHint={form.upstreamMode === "split" ? "Codex 压缩请求会转发到这里。" : "当前复用 Codex 主路由。"}
          apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Codex 压缩路由", config?.compact ?? null)}
          baseUrl={form.codexCompactBaseUrl} apiKey={form.codexCompactApiKey}
          storedApiKey={config?.compact.stored_api_key ?? false}
          clearApiKey={form.clearCodexCompactApiKey}
          routeUrlSuggestions={routeUrlSuggestions(config, "codex_compact")}
          onBaseUrlChange={(value) => onFormChange((previous) => ({ ...previous, codexCompactBaseUrl: value }))}
          onApiKeyChange={(value) => onFormChange((previous) => ({
            ...previous,
            codexCompactApiKey: value,
            clearCodexCompactApiKey: false
          }))}
          onToggleClearApiKey={() => onFormChange((previous) => ({
            ...previous,
            codexCompactApiKey: "",
            clearCodexCompactApiKey: !previous.clearCodexCompactApiKey
          }))}
        />
      </div>
      <div className="config-row">
        <RouteCredentialFields
          title="Claude 主路由" badge="Claude" tone="claude"
          baseUrlLabel="基础地址" baseUrlHint="所有 Claude Code Messages 请求都会转发到这里。"
          apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Claude 主路由", config?.claude.primary ?? null)}
          baseUrl={form.claudePrimaryBaseUrl} apiKey={form.claudePrimaryApiKey}
          storedApiKey={config?.claude.primary.stored_api_key ?? false}
          clearApiKey={form.clearClaudePrimaryApiKey}
          routeUrlSuggestions={routeUrlSuggestions(config, "claude_primary")}
          onBaseUrlChange={(value) => onFormChange((previous) => ({ ...previous, claudePrimaryBaseUrl: value }))}
          onApiKeyChange={(value) => onFormChange((previous) => ({ ...previous, claudePrimaryApiKey: value, clearClaudePrimaryApiKey: false }))}
          onToggleClearApiKey={() => onFormChange((previous) => ({ ...previous, claudePrimaryApiKey: "", clearClaudePrimaryApiKey: !previous.clearClaudePrimaryApiKey }))}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
        <div>
          <div className="field-label" style={{ marginBottom: 4 }}>Codex 压缩上游模式</div>
          <div className="toggle-group">
            <button className={form.upstreamMode === "split" ? "is-active" : ""} onClick={() => onFormChange((previous) => ({ ...previous, upstreamMode: "split" }))}>独立分流</button>
            <button className={form.upstreamMode === "primary" ? "is-active" : ""} onClick={() => onFormChange((previous) => ({ ...previous, upstreamMode: "primary" }))}>复用主路由</button>
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
