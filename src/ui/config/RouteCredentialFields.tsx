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

const KEY_STRATEGY_OPTIONS: SelectOption[] = [
  {
    value: "fill_first",
    label: "故障转移（用尽再换）",
    meta: "适合订阅型 5h / 7d 窗口配额"
  },
  {
    value: "spread",
    label: "分摊（同时轮转）",
    meta: "适合按 token 计费的中转站"
  }
];

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
  storedApiKey,
  clearApiKey,
  routeUrlSuggestions = [],
  keyPool,
  keyStrategy,
  rotationOptOut,
  stickyReserveSeconds,
  onBaseUrlChange,
  onSuggestionSelect,
  onApiKeyChange,
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
  storedApiKey: boolean;
  clearApiKey: boolean;
  routeUrlSuggestions?: RouteUrlSuggestion[];
  keyPool?: FormKeyPoolEntry[];
  keyStrategy?: PrimaryKeyStrategy;
  rotationOptOut?: boolean;
  stickyReserveSeconds?: number;
  onBaseUrlChange: (value: string) => void;
  onSuggestionSelect?: (suggestion: RouteUrlSuggestion) => void;
  onApiKeyChange: (value: string) => void;
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
    onRotationOptOutChange &&
    onStickyReserveChange
  );

  function updateEntry(id: string, patch: Partial<Omit<FormKeyPoolEntry, "id" | "tail">>) {
    if (!keyPool || !onKeyPoolChange) {
      return;
    }
    onKeyPoolChange(keyPool.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }
  const [urlSuggestionsOpen, setUrlSuggestionsOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [suggestionsStyle, setSuggestionsStyle] = useState<CSSProperties | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
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

      {showKeyPool && keyPool && (
        <section className="key-pool-editor" aria-label={`${title} 密钥池`}>
          <div className="key-pool-editor-head">
            <h5>密钥池（同一档案多账号轮转）</h5>
            <span className="route-chip primary">
              {keyPool.filter((entry) => entry.enabled).length}/{keyPool.length} 可用
            </span>
          </div>
          <p className="key-pool-editor-hint">
            每把密钥是一个独立上游账号：故障转移时按序使用，401/429 单独冷却与隔离，加密会话状态按密钥隔离。
          </p>

          {keyPool.length === 0 ? (
            <p className="key-pool-empty">
              还没有密钥。添加第二把密钥后，本档案会在它们之间自动轮转 —— 单把密钥就是原有行为。
            </p>
          ) : (
            <div className="key-pool-rows">
              {keyPool.map((entry, index) => (
                <div
                  key={entry.id}
                  className={`key-pool-row${entry.enabled ? "" : " is-disabled"}`}
                >
                  <span className="key-pool-index">{index + 1}</span>
                  <input
                    className="key-pool-label-input"
                    aria-label="密钥标签"
                    placeholder={entry.tail ? `密钥 …${entry.tail}` : "新密钥标签"}
                    value={entry.label}
                    onChange={(event) => updateEntry(entry.id, { label: event.target.value })}
                  />
                  <input
                    className="key-pool-secret-input"
                    aria-label="密钥值"
                    type="password"
                    autoComplete="off"
                    placeholder={entry.tail ? "输入新值以覆盖，留空保持不变" : "sk-..."}
                    value={entry.apiKey}
                    onChange={(event) => updateEntry(entry.id, { apiKey: event.target.value })}
                    spellCheck={false}
                  />
                  <label className="key-pool-toggle">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onChange={(event) => updateEntry(entry.id, { enabled: event.target.checked })}
                    />
                    <span className="key-pool-track" aria-hidden="true">
                      <span className="key-pool-thumb" />
                    </span>
                    <span className="key-pool-toggle-text">启用</span>
                  </label>
                  {/*
                    Two-step for a row that is already saved. Its secret lives only
                    on the server — the pool never sends plaintext back, only a tail
                    — so a misclick costs a trip to wherever the key came from. A row
                    with no tail was added in this draft and has nothing to lose, so
                    it goes on the first click.
                  */}
                  <button
                    className="field-inline-button is-danger"
                    type="button"
                    aria-label={pendingDeleteId === entry.id
                      ? `确认删除密钥 ${entry.label || entry.tail || entry.id}`
                      : `删除密钥 ${entry.label || entry.tail || entry.id}`}
                    onClick={() => {
                      if (!entry.tail || pendingDeleteId === entry.id) {
                        setPendingDeleteId(null);
                        onKeyPoolChange?.(keyPool.filter((item) => item.id !== entry.id));
                        return;
                      }
                      setPendingDeleteId(entry.id);
                    }}
                    onBlur={() => setPendingDeleteId((current) =>
                      current === entry.id ? null : current)}
                  >
                    {pendingDeleteId === entry.id ? "确认删除" : "删除"}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="key-pool-actions">
            <button
              className="ghost-button key-pool-add"
              type="button"
              onClick={() => onKeyPoolChange?.([...keyPool, {
                id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                label: "",
                apiKey: "",
                enabled: true,
                tail: ""
              }])}
            >
              + 添加密钥
            </button>
          </div>

          <div className="key-pool-policies">
            <CustomSelect
              label="轮转策略"
              value={keyStrategy ?? "fill_first"}
              options={KEY_STRATEGY_OPTIONS}
              onChange={(value) => onKeyStrategyChange?.(value as PrimaryKeyStrategy)}
            />
            <Field label="粘性保留带宽（秒）" hint="429 冷却结束后仍只服务已绑定会话的时长；0 关闭。">
              <input
                type="number"
                min={0}
                max={86400}
                value={stickyReserveSeconds ?? 0}
                onChange={(event) => onStickyReserveChange?.(Number(event.target.value))}
              />
            </Field>
            <label className="key-pool-policy-toggle">
              <input
                type="checkbox"
                checked={rotationOptOut ?? false}
                onChange={(event) => onRotationOptOutChange?.(event.target.checked)}
              />
              <span className="key-pool-track" aria-hidden="true">
                <span className="key-pool-thumb" />
              </span>
              <span>不参与自动轮转（账号绑定凭据，如 OAuth；故障转移永不主动使用）</span>
            </label>
          </div>
        </section>
      )}
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
