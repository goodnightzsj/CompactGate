import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type {
  PrimaryKeyStrategy,
  UpstreamProtocol
} from "../../shared/types.js";
import { clamp, formatClock } from "../shared/format.js";
import { CustomSelect, type SelectOption } from "../shared/CustomSelect.js";
import { Field } from "./Field.js";
import type { FormKeyPoolEntry } from "./types.js";
import type { OAuthAccountView } from "../../shared/oauth.js";
import { oauthStatusLabel } from "./useOAuthAccounts.js";
import { ApiKeyPoolEditor } from "./ApiKeyPoolEditor.js";

const UPSTREAM_PROTOCOL_OPTIONS: SelectOption[] = [
  {
    value: "openai_responses",
    label: "OpenAI Responses",
    meta: "/v1/responses"
  },
  {
    value: "anthropic_messages",
    label: "Anthropic Messages",
    meta: "/v1/messages"
  },
  {
    value: "openai_chat",
    label: "OpenAI Chat",
    meta: "/v1/chat/completions"
  }
];

export type RouteUrlSuggestion = {
  baseUrl: string;
  credentialPresetId: string;
  apiKeyEnv: string;
  storedApiKey: boolean;
  apiKeyConfigured: boolean;
  host: string;
  label: string;
  updatedAt: string;
};

export function RouteCredentialFields({
  title,
  badge,
  tone,
  baseUrlLabel,
  baseUrlHint,
  apiKeyLabel,
  apiKeyHint,
  upstreamProtocol,
  baseUrl,
  apiKey,
  apiKeyPriority = 0,
  storedApiKey,
  storedApiKeyTail = "",
  clearApiKey,
  routeUrlSuggestions = [],
  credentialPresetId = "",
  keyPool,
  keyStrategy,
  rotationOptOut,
  stickyReserveSeconds,
  keyRotationEnabled = true,
  keyActivity,
  oauthAccountId = "",
  oauthAccounts = [],
  onOAuthAccountChange,
  onManageOAuth,
  onBaseUrlChange,
  onSuggestionSelect,
  onApiKeyChange,
  onApiKeyPriorityChange,
  onUpstreamProtocolChange,
  onToggleClearApiKey,
  onKeyPoolChange,
  onKeyStrategyChange,
  onRotationOptOutChange,
  onStickyReserveChange
}: {
  title: string;
  badge: string;
  tone: "primary" | "compact" | "claude";
  baseUrlLabel: string;
  baseUrlHint: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  upstreamProtocol: UpstreamProtocol;
  baseUrl: string;
  apiKey: string;
  apiKeyPriority?: number | "";
  storedApiKey: boolean;
  /** Tail of the stored direct key, so the pool can label its leading row. */
  storedApiKeyTail?: string;
  clearApiKey: boolean;
  routeUrlSuggestions?: RouteUrlSuggestion[];
  credentialPresetId?: string;
  keyPool?: FormKeyPoolEntry[];
  keyStrategy?: PrimaryKeyStrategy;
  rotationOptOut?: boolean;
  stickyReserveSeconds?: number;
  keyRotationEnabled?: boolean;
  keyActivity?: { key_id: string; used_at: string };
  oauthAccountId?: string;
  oauthAccounts?: OAuthAccountView[];
  onOAuthAccountChange?: (account: OAuthAccountView | null) => void;
  onManageOAuth: () => void;
  onBaseUrlChange: (value: string) => void;
  onSuggestionSelect?: (suggestion: RouteUrlSuggestion) => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyPriorityChange?: (value: number | "") => void;
  onUpstreamProtocolChange: (value: UpstreamProtocol) => void;
  onToggleClearApiKey: () => void;
  onKeyPoolChange?: (entries: FormKeyPoolEntry[]) => void;
  onKeyStrategyChange?: (strategy: PrimaryKeyStrategy) => void;
  onRotationOptOutChange?: (optedOut: boolean) => void;
  onStickyReserveChange?: (seconds: number) => void;
}) {
  const showKeyPool = Boolean(
    keyPool &&
    onKeyPoolChange &&
    onKeyStrategyChange &&
    onApiKeyPriorityChange &&
    onRotationOptOutChange &&
    onStickyReserveChange
  );

  const [urlSuggestionsOpen, setUrlSuggestionsOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [suggestionsStyle, setSuggestionsStyle] = useState<CSSProperties | null>(null);
  const baseUrlInputRef = useRef<HTMLInputElement | null>(null);
  const repositionFrameRef = useRef<number | null>(null);
  const blurCloseTimerRef = useRef<number | null>(null);
  const suggestionsId = useId();
  const visibleSuggestions = routeUrlSuggestions.slice(0, 8);
  const showSuggestions = urlSuggestionsOpen && visibleSuggestions.length > 0;
  const activeSuggestionId =
    showSuggestions && activeSuggestionIndex >= 0
      ? `${suggestionsId}-option-${activeSuggestionIndex}`
      : undefined;
  const selectedPreset = routeUrlSuggestions.find((suggestion) =>
    credentialPresetId.length > 0 && suggestion.credentialPresetId === credentialPresetId);
  const hasDirectKey = apiKey.trim().length > 0 || (!clearApiKey && (selectedPreset?.storedApiKey ?? storedApiKey));
  const directTail = apiKey.trim() ? apiKey.trim().slice(-4) : selectedPreset ? "" : storedApiKeyTail;
  useEffect(() => {
    if (!showSuggestions) {
      setActiveSuggestionIndex(-1);
      return;
    }

    setActiveSuggestionIndex((previous) =>
      previous >= visibleSuggestions.length ? visibleSuggestions.length - 1 : previous
    );
  }, [showSuggestions, visibleSuggestions.length]);

  /**
   * `.config-section` and (on narrow screens) `.route-config-card` both clip
   * their overflow, and the animated page wrapper keeps a transform, so an
   * absolutely positioned list was cut off with no way to scroll to the rest of
   * it. Same treatment as `.custom-select-menu`: portal it out and place it in
   * viewport coordinates.
   */
  useLayoutEffect(() => {
    if (!showSuggestions) {
      setSuggestionsStyle(null);
      return undefined;
    }

    function place() {
      const input = baseUrlInputRef.current;
      if (!input) {
        return;
      }

      const rect = input.getBoundingClientRect();
      const viewportPadding = 12;
      const gap = 6;
      const availableBelow = window.innerHeight - rect.bottom - viewportPadding - gap;
      const availableAbove = rect.top - viewportPadding - gap;
      const openBelow = availableBelow >= availableAbove;
      const maxHeight = Math.max(
        120,
        Math.min(230, openBelow ? availableBelow : availableAbove)
      );

      setSuggestionsStyle({
        left: clamp(
          rect.left,
          viewportPadding,
          Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding)
        ),
        top: openBelow ? rect.bottom + gap : Math.max(viewportPadding, rect.top - maxHeight - gap),
        width: rect.width,
        maxHeight
      });
    }

    function scheduleReposition() {
      if (repositionFrameRef.current !== null) {
        return;
      }
      repositionFrameRef.current = requestAnimationFrame(() => {
        repositionFrameRef.current = null;
        place();
      });
    }

    place();
    window.addEventListener("resize", scheduleReposition);
    window.addEventListener("scroll", scheduleReposition, true);
    return () => {
      window.removeEventListener("resize", scheduleReposition);
      window.removeEventListener("scroll", scheduleReposition, true);
      if (repositionFrameRef.current !== null) {
        cancelAnimationFrame(repositionFrameRef.current);
        repositionFrameRef.current = null;
      }
    };
  }, [showSuggestions, visibleSuggestions.length]);

  // Unmount only — the effect above re-runs on its deps, so clearing the blur timer
  // there would cancel a close that is still legitimately pending.
  useEffect(() => () => {
    if (blurCloseTimerRef.current !== null) {
      window.clearTimeout(blurCloseTimerRef.current);
      blurCloseTimerRef.current = null;
    }
  }, []);

  function selectSuggestion(suggestion: RouteUrlSuggestion) {
    if (onSuggestionSelect) {
      onSuggestionSelect(suggestion);
    } else {
      onBaseUrlChange(suggestion.baseUrl);
    }
    setUrlSuggestionsOpen(false);
    setActiveSuggestionIndex(-1);
  }

  return (
    <section className={`route-config-card tone-${tone}`} aria-label={title}>
      <div className="route-config-card-head">
        <h4>{title}</h4>
        <span className={`route-chip ${tone}`}>{badge}</span>
      </div>

      {onOAuthAccountChange && <CustomSelect
        label={`${title} 认证来源`}
        value={oauthAccountId}
        options={[
          { value: "", label: "手动 API key", meta: "使用下方保存的密钥或密钥池" },
          ...(oauthAccountId && !oauthAccounts.some((item) => item.id === oauthAccountId)
            ? [{ value: oauthAccountId, label: "OAuth · 连接待加载或缺失", disabled: true }] : []),
          ...oauthAccounts.map((account) => ({
            value: account.id,
            label: account.label,
            meta: `OAuth · ${oauthStatusLabel[account.status]}`,
            disabled: account.status !== "connected" && !(account.status === "expired" && account.can_refresh)
          }))
        ]}
        onChange={(id) => {
          if (!id) onOAuthAccountChange(null);
          else {
            const account = oauthAccounts.find((item) => item.id === id);
            if (account) onOAuthAccountChange(account);
          }
        }}
        wide
      />}
      {oauthAccountId ? <div className="oauth-route-summary">
        <strong>OAuth · {oauthStatusLabel[oauthAccounts.find((item) => item.id === oauthAccountId)?.status ?? "missing"]}</strong>
        <span>{upstreamProtocol}</span><code>{baseUrl}</code>
        <a href="/config/profiles" onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onManageOAuth();
        }}>管理授权连接</a>
      </div> : <>
      <CustomSelect
        label={`${title} 上游格式`}
        value={upstreamProtocol}
        options={UPSTREAM_PROTOCOL_OPTIONS}
        onChange={(value) => onUpstreamProtocolChange(value as UpstreamProtocol)}
        wide
      />

      <Field label={baseUrlLabel} hint={baseUrlHint}>
        <div className="route-url-input-wrap">
          <input
            ref={baseUrlInputRef}
            aria-label={baseUrlLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-activedescendant={activeSuggestionId}
            aria-controls={showSuggestions ? suggestionsId : undefined}
            aria-expanded={showSuggestions}
            aria-haspopup="listbox"
            value={baseUrl}
            onFocus={() => {
              // Cancel a close still pending from a blur a moment ago, or it fires
              // and collapses the list the user has just come back to.
              if (blurCloseTimerRef.current !== null) {
                window.clearTimeout(blurCloseTimerRef.current);
                blurCloseTimerRef.current = null;
              }
              setUrlSuggestionsOpen(true);
            }}
            onBlur={() => {
              blurCloseTimerRef.current = window.setTimeout(() => {
                blurCloseTimerRef.current = null;
                setUrlSuggestionsOpen(false);
                setActiveSuggestionIndex(-1);
              }, 100);
            }}
            onChange={(event) => {
              setUrlSuggestionsOpen(true);
              setActiveSuggestionIndex(-1);
              onBaseUrlChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && urlSuggestionsOpen) {
                event.preventDefault();
                setUrlSuggestionsOpen(false);
                setActiveSuggestionIndex(-1);
                return;
              }

              if (visibleSuggestions.length === 0) {
                return;
              }

              if (event.key === "ArrowDown") {
                event.preventDefault();
                setUrlSuggestionsOpen(true);
                setActiveSuggestionIndex((previous) =>
                  previous < 0 ? 0 : (previous + 1) % visibleSuggestions.length
                );
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                setUrlSuggestionsOpen(true);
                setActiveSuggestionIndex((previous) =>
                  previous < 0
                    ? visibleSuggestions.length - 1
                    : (previous - 1 + visibleSuggestions.length) % visibleSuggestions.length
                );
                return;
              }

              if (event.key === "Enter" && showSuggestions && activeSuggestionIndex >= 0) {
                event.preventDefault();
                selectSuggestion(visibleSuggestions[activeSuggestionIndex]);
              }
            }}
            spellCheck={false}
          />
          {showSuggestions && suggestionsStyle && createPortal(
            <div
              id={suggestionsId}
              className="route-url-suggestions"
              role="listbox"
              style={suggestionsStyle}
            >
              {visibleSuggestions.map((suggestion, index) => (
                <button
                  id={`${suggestionsId}-option-${index}`}
                  key={`${suggestion.baseUrl}:${suggestion.label}`}
                  type="button"
                  className="route-url-suggestion"
                  role="option"
                  aria-selected={index === activeSuggestionIndex}
                  data-active={index === activeSuggestionIndex || suggestion.baseUrl === baseUrl}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(suggestion)}
                >
                  <span className="route-url-suggestion-main">
                    <strong>{suggestion.host}</strong>
                    <small>{suggestion.baseUrl}</small>
                  </span>
                  <span className="route-url-suggestion-meta">
                    <span>{suggestion.label}</span>
                    <span>{credentialSummary(suggestion)}</span>
                    <span>{formatClock(suggestion.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )}
        </div>
      </Field>

      <Field label={apiKeyLabel} hint={apiKeyHint}>
        <input
          aria-label={apiKeyLabel}
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={storedApiKey ? "输入新值以覆盖已保存密钥" : "sk-..."}
          onChange={(event) => onApiKeyChange(event.target.value)}
          spellCheck={false}
        />
        {(storedApiKey || clearApiKey) && (
          <div className="field-action-row">
            <button
              className={`field-inline-button ${clearApiKey ? "is-danger" : ""}`}
              type="button"
              onClick={onToggleClearApiKey}
            >
              {clearApiKey ? "取消清空" : "清空已保存密钥"}
            </button>
          </div>
        )}
      </Field>

      {showKeyPool && keyPool && <ApiKeyPoolEditor
        title={title} direct={{ configured: hasDirectKey, tail: directTail, priority: apiKeyPriority }}
        entries={keyPool} strategy={keyStrategy ?? "fill_first"} rotationEnabled={keyRotationEnabled}
        rotationOptOut={rotationOptOut ?? false} stickyReserveSeconds={stickyReserveSeconds ?? 0}
        activity={keyActivity} onEntriesChange={onKeyPoolChange!} onDirectPriorityChange={onApiKeyPriorityChange!}
        onStrategyChange={onKeyStrategyChange!} onRotationOptOutChange={onRotationOptOutChange!}
        onStickyReserveChange={onStickyReserveChange!}
      />}
      </>}
    </section>
  );
}

function credentialSummary(suggestion: RouteUrlSuggestion): string {
  if (suggestion.storedApiKey) {
    return "含直填密钥";
  }

  if (suggestion.apiKeyEnv) {
    return suggestion.apiKeyConfigured
      ? `环境变量 ${suggestion.apiKeyEnv}`
      : `环境变量 ${suggestion.apiKeyEnv} 未设置`;
  }

  return "无绑定密钥";
}
