import { useState } from "react";
import type {
  ClientIdentityKind,
  ClientIdentityKindStatus,
  ClientIdentityResolved,
  ClientIdentitySourceKind,
  ClientIdentityStatus,
  ClientIdentityUaStatus
} from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";

const SOURCE_LABEL: Record<ClientIdentitySourceKind, string> = {
  extracted: "CLI 提取",
  version_tracked: "版本跟随"
};

const KIND_META: Record<ClientIdentityKind, { name: string; protocol: string; chip: string }> = {
  codex: { name: "Codex", protocol: "OpenAI 协议", chip: "codex" },
  claude: { name: "Claude Code", protocol: "Anthropic 协议", chip: "claude" }
};

/**
 * Live control for outbound User-Agent rewriting. Every mutation goes straight to
 * `/api/client-identity` and takes effect immediately — unlike the config page,
 * there is no draft to save, because an operator reaching for this is usually
 * chasing a relay that is rejecting requests right now.
 */
export function ClientIdentityPanel({ status }: { status: ClientIdentityStatus | null }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<ClientIdentityStatus | null>(null);
  const current = local ?? status;

  const submit = async (patch: unknown) => {
    setPending(true);
    setError(null);
    try {
      // The SSE snapshot carries the same state a moment later; holding the
      // response locally keeps the radio and switch from flicking back first.
      setLocal(await api<ClientIdentityStatus>("/api/client-identity", {
        method: "POST",
        body: JSON.stringify(patch)
      }));
    } catch (cause) {
      setError(errorSummary(cause));
    } finally {
      setPending(false);
    }
  };

  if (!current) {
    return (
      <section className="identity-panel" aria-labelledby="client-identity-title">
        <div className="identity-head">
          <div>
            <p className="eyebrow">出站身份</p>
            <h3 id="client-identity-title">客户端 UA 改写</h3>
            <p className="identity-subtitle">读取中…</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`identity-panel ${current.enabled ? "" : "is-off"}`}
      aria-labelledby="client-identity-title"
    >
      <div className="identity-head">
        <div>
          <p className="eyebrow">出站身份</p>
          <h3 id="client-identity-title">客户端 UA 改写</h3>
          <p className="identity-subtitle">
            仅改写非 CLI 客户端的 <code>User-Agent</code>，其余请求头一律不动；真实 CLI 请求原样透传，并作为提取来源。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={current.enabled}
          className={`identity-switch ${current.enabled ? "is-on" : ""}`}
          disabled={pending}
          onClick={() => void submit({ enabled: !current.enabled })}
        >
          <span className="identity-switch-track" aria-hidden="true">
            <span className="identity-switch-knob" />
          </span>
          {current.enabled ? "已启用" : "已关闭"}
        </button>
      </div>

      {error && (
        <p className="identity-error" role="alert">{error}</p>
      )}

      <div className="identity-grid">
        {(["codex", "claude"] as const).map((kind) => (
          <IdentityCard
            key={kind}
            kind={kind}
            state={current[kind]}
            resolved={current.resolved[kind]}
            enabled={current.enabled}
            disabled={pending}
            onSubmit={submit}
          />
        ))}
      </div>
    </section>
  );
}

function IdentityCard({
  kind,
  state,
  resolved,
  enabled,
  disabled,
  onSubmit
}: {
  kind: ClientIdentityKind;
  state: ClientIdentityKindStatus;
  resolved: ClientIdentityResolved;
  enabled: boolean;
  disabled: boolean;
  onSubmit: (patch: unknown) => Promise<void>;
}) {
  const meta = KIND_META[kind];

  return (
    <article className={`identity-card ${meta.chip}`}>
      <header className="identity-card-head">
        <span className={`route-chip ${meta.chip}`}>{meta.name}</span>
        <span className="identity-card-protocol">{meta.protocol}</span>
      </header>

      <div
        className="identity-sources"
        role="radiogroup"
        aria-label={`${meta.name} 生效的 User-Agent 来源`}
      >
        {(["extracted", "version_tracked"] as const).map((source) => (
          <IdentitySource
            key={source}
            kind={kind}
            source={source}
            state={state[source]}
            kindState={state}
            // Nothing is on the wire while rewriting is off, so the live marker
            // would be a claim the proxy is not making.
            active={enabled && resolved.source === source}
            selected={state.preferred === source}
            disabled={disabled}
            onSubmit={onSubmit}
          />
        ))}
      </div>

      <footer className="identity-card-actions">
        <span className="identity-card-note">
          {!enabled
            ? "改写已关闭，客户端 UA 原样透传"
            : resolved.fell_back
              ? `首选来源不可用，当前由「${resolved.source ? SOURCE_LABEL[resolved.source] : "无"}」出站`
              : "首选来源正在出站"}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={disabled}
          onClick={() => void onSubmit({ refresh: true, kind })}
        >
          刷新远端版本
        </button>
      </footer>
    </article>
  );
}

function IdentitySource({
  kind,
  source,
  state,
  kindState,
  active,
  selected,
  disabled,
  onSubmit
}: {
  kind: ClientIdentityKind;
  source: ClientIdentitySourceKind;
  state: ClientIdentityUaStatus;
  kindState: ClientIdentityKindStatus;
  active: boolean;
  selected: boolean;
  disabled: boolean;
  onSubmit: (patch: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const empty = state.user_agent.length === 0;
  const field = source === "extracted" ? "extracted_user_agent" : "version_tracked_user_agent";
  // What the upstream would see, which is not the stored value whenever a registry
  // version is being applied. Editing still targets the stored value.
  const outbound = state.outbound_user_agent || state.user_agent;

  const save = async () => {
    if (draft === null) {
      return;
    }
    await onSubmit({ [kind]: { [field]: draft } });
    setDraft(null);
  };

  return (
    <div
      className={[
        "identity-source",
        selected ? "is-selected" : "",
        active ? "is-active" : "",
        empty ? "is-empty" : ""
      ].filter(Boolean).join(" ")}
    >
      <label className="identity-source-head">
        <input
          type="radio"
          name={`identity-source-${kind}`}
          checked={selected}
          // An empty source cannot serve, so offering it as a choice would only
          // produce a selection the resolver silently overrides.
          disabled={disabled || empty}
          onChange={() => void onSubmit({ [kind]: { preferred: source } })}
        />
        <span className="identity-source-name">{SOURCE_LABEL[source]}</span>
        <SourceBadge state={state} empty={empty} />
        {active && <span className="identity-source-live">出站中</span>}
      </label>

      {draft === null ? (
        <code className="identity-source-value" title={outbound || undefined}>
          {outbound || "尚未取得"}
        </code>
      ) : (
        <input
          className="identity-source-input"
          value={draft}
          spellCheck={false}
          aria-label={`${SOURCE_LABEL[source]} User-Agent`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void save();
            }
            if (event.key === "Escape") {
              setDraft(null);
            }
          }}
        />
      )}

      <p className="identity-source-meta">{sourceMeta(source, state, kindState)}</p>

      <div className="identity-source-actions">
        {draft === null ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={disabled}
              onClick={() => setDraft(state.user_agent)}
            >
              手动编辑
            </button>
            {state.manual && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={disabled}
                onClick={() => void onSubmit({ [kind]: { [field]: null } })}
              >
                恢复自动
              </button>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={disabled}
              onClick={() => void save()}
            >
              保存
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={disabled}
              onClick={() => setDraft(null)}
            >
              取消
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SourceBadge({ state, empty }: { state: ClientIdentityUaStatus; empty: boolean }) {
  if (state.manual) {
    return <span className="protocol-chip remote-v1">手动</span>;
  }
  if (empty) {
    return <span className="protocol-chip unknown">等待观测</span>;
  }
  if (state.last_error) {
    return <span className="protocol-chip mixed">更新失败</span>;
  }
  return <span className="protocol-chip local">自动</span>;
}

function sourceMeta(
  source: ClientIdentitySourceKind,
  state: ClientIdentityUaStatus,
  kindState: ClientIdentityKindStatus
): string {
  if (state.manual) {
    return `手动设定于 ${formatTime(state.updated_at)}，自动更新已暂停`;
  }

  if (source === "extracted") {
    return state.updated_at
      ? `观测于 ${formatTime(state.updated_at)} · 每天只取一次`
      : "等待一次真实 CLI 请求经过本代理";
  }

  const version = kindState.remote_version ?? "未取得";
  const fetched = kindState.remote_version_at
    ? `拉取于 ${formatTime(kindState.remote_version_at)}`
    : "尚未拉取";
  const failure = state.last_error ? ` · ${state.last_error}` : "";
  return `远端版本 ${version} · ${fetched}${failure}`;
}

function formatTime(value: string | null): string {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
