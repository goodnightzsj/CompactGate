import { useEffect, useId, useState } from "react";
import { formatClock } from "../shared/format.js";
import { Field } from "./Field.js";

export type RouteUrlSuggestion = {
  baseUrl: string;
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
  baseUrl,
  apiKey,
  storedApiKey,
  clearApiKey,
  routeUrlSuggestions = [],
  onBaseUrlChange,
  onApiKeyChange,
  onToggleClearApiKey
}: {
  title: string;
  badge: string;
  tone: "primary" | "compact" | "claude";
  baseUrlLabel: string;
  baseUrlHint: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  baseUrl: string;
  apiKey: string;
  storedApiKey: boolean;
  clearApiKey: boolean;
  routeUrlSuggestions?: RouteUrlSuggestion[];
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onToggleClearApiKey: () => void;
}) {
  const [urlSuggestionsOpen, setUrlSuggestionsOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
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

  function selectSuggestion(suggestion: RouteUrlSuggestion) {
    onBaseUrlChange(suggestion.baseUrl);
    setUrlSuggestionsOpen(false);
    setActiveSuggestionIndex(-1);
  }

  return (
    <section className={`route-config-card tone-${tone}`} aria-label={title}>
      <div className="route-config-card-head">
        <h4>{title}</h4>
        <span className={`route-chip ${tone}`}>{badge}</span>
      </div>

      <Field label={baseUrlLabel} hint={baseUrlHint}>
        <div className="route-url-input-wrap">
          <input
            aria-label={baseUrlLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-activedescendant={activeSuggestionId}
            aria-controls={showSuggestions ? suggestionsId : undefined}
            aria-expanded={showSuggestions}
            aria-haspopup="listbox"
            value={baseUrl}
            onFocus={() => setUrlSuggestionsOpen(true)}
            onBlur={() => {
              window.setTimeout(() => {
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
          {showSuggestions && (
            <div id={suggestionsId} className="route-url-suggestions" role="listbox">
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
                    <span>{formatClock(suggestion.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
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
    </section>
  );
}
