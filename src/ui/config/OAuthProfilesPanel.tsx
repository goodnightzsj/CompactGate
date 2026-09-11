import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { OAUTH_PROVIDERS, type OAuthAccountView, type OAuthMethod, type OAuthProviderId, type OAuthSessionView } from "../../shared/oauth.js";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";
import { CustomSelect } from "../shared/CustomSelect.js";
import { oauthStatusLabel, useOAuthAccounts } from "./useOAuthAccounts.js";

const methodLabel: Record<OAuthMethod, string> = { browser: "浏览器授权", device_code: "设备码授权" };
const providerOptions = OAUTH_PROVIDERS.map((provider) => ({
  value: provider.id, label: provider.name, meta: provider.methods.map((method) => methodLabel[method]).join(" / ")
}));
const pending = (session: OAuthSessionView | null) => session?.status === "pending" || session?.status === "exchanging";
const sessionLabel: Record<OAuthSessionView["status"], string> = {
  pending: "等待厂商授权", exchanging: "正在确认授权", connected: "授权完成",
  cancelled: "授权已取消", expired: "授权已过期", error: "授权失败"
};

function openDisconnectDialog(node: HTMLDialogElement | null) {
  node?.showModal();
  // Close before React removes the dialog so the browser restores trigger focus.
  return () => node?.close();
}

export function OAuthProfilesPanel({ config, onConfigChange, onProfileLocate }: {
  config: PublicConfig | null;
  onConfigChange: (config: PublicConfig) => void;
  onProfileLocate: (scope: ConfigProfileScope, profileId: string) => void;
}) {
  const { accounts, loading, error: accountsError, reload } = useOAuthAccounts();
  const [providerId, setProviderId] = useState<OAuthProviderId>("openai-codex");
  const provider = OAUTH_PROVIDERS.find((item) => item.id === providerId)!;
  const [method, setMethod] = useState<OAuthMethod>("browser");
  const [label, setLabel] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("global");
  const [session, setSession] = useState<OAuthSessionView | null>(null);
  const [callback, setCallback] = useState("");
  const [accountId, setAccountId] = useState("");
  const [scope, setScope] = useState<ConfigProfileScope>("codex");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createdProfile, setCreatedProfile] = useState<{ scope: ConfigProfileScope; id: string } | null>(null);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const sessionRef = useRef(session);
  const operation = useRef<AbortController | null>(null);
  const connectDetails = useRef<HTMLDetailsElement | null>(null);
  const profileNameInput = useRef<HTMLInputElement | null>(null);
  const id = useId();
  sessionRef.current = session;
  const account = accounts.find((item) => item.id === accountId);
  const disconnectAccount = accounts.find((item) => item.id === disconnectId);
  const busy = action !== null;
  const canUse = (value: OAuthAccountView) => value.status === "connected" || (value.status === "expired" && value.can_refresh);
  const locatedProfile = createdProfile && config?.profile_scopes[createdProfile.scope].profiles.find((item) => item.id === createdProfile.id);

  useEffect(() => {
    if (!account?.id) return;
    profileNameInput.current?.focus({ preventScroll: true });
    profileNameInput.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [account?.id]);

  useEffect(() => () => {
    operation.current?.abort();
    const current = sessionRef.current;
    if (current && pending(current)) {
      void api(`/api/oauth/sessions/${current.id}`, { method: "DELETE", keepalive: true })
        .catch((reason: unknown) => console.error("OAuth cancellation failed", reason));
    }
  }, []);

  useEffect(() => {
    if (!session || !pending(session) || error || busy) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<OAuthSessionView>(`/api/oauth/sessions/${session.id}${session.method === "device_code" ? "/poll" : ""}`, {
        method: session.method === "device_code" ? "POST" : "GET", signal: controller.signal
      }).then((next) => {
        if (controller.signal.aborted) return;
        setSession(next);
        if (next.status === "connected" && next.account_id) {
          setAccountId(next.account_id);
          setModel("");
          setModels([]);
          reload();
        }
      }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorSummary(reason)); });
    }, session.poll_after_ms);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [session, error, busy, reload]);

  async function run(key: string, work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setAction(key);
    setError(null);
    setNotice(null);
    setCreatedProfile(null);
    try { await work(controller.signal); }
    catch (reason) { if (!controller.signal.aborted) setError(errorSummary(reason)); }
    finally {
      operation.current = null;
      if (!controller.signal.aborted) setAction(null);
    }
  }

  function start(event: FormEvent) {
    event.preventDefault();
    void run("start", async (signal) => {
      const next = await api<OAuthSessionView>("/api/oauth/sessions", {
        method: "POST", signal, body: JSON.stringify({ provider: providerId, method, label: label.trim() || provider.name,
          ...(providerId === "google-vertex" ? { settings: { client_id: clientId, client_secret: clientSecret, project_id: project, location } } : {}) })
      });
      if (!signal.aborted) { setSession(next); setCallback(""); setClientSecret(""); }
    });
  }

  function createProfile(event: FormEvent) {
    event.preventDefault();
    if (!config || !account) return;
    if (config.profile_scopes[scope].profiles.some((item) => item.name === name.trim())) {
      setError("这个客户端已有同名档案，请更换名称。");
      return;
    }
    void run("create", async (signal) => {
      const next = await api<PublicConfig>("/api/oauth/profiles", {
        method: "POST", signal, body: JSON.stringify({ account_id: account.id, scope, name: name.trim(), model: model.trim(), revision: config.revision })
      });
      if (signal.aborted) return;
      onConfigChange(next);
      const created = next.profile_scopes[scope].profiles.find((item) => item.name === name.trim() && item.oauth_account_id === account.id);
      if (!created) throw new Error("档案已保存，但返回列表中未找到新档案。请刷新配置后查看。");
      setCreatedProfile({ scope, id: created.id });
      setNotice(`已创建「${name.trim()}」，当前运行档案未切换。`);
      setName("");
    });
  }

  const profileForm = account && canUse(account) && <form id={`${id}-profile-form`} className="oauth-form oauth-profile-form" onSubmit={createProfile}>
    <h4>使用「{account.label}」创建档案</h4>
    <CustomSelect label="客户端" disabled={busy} value={scope} options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }]} onChange={(value) => setScope(value as ConfigProfileScope)} />
    <label className="field">新档案名称<input ref={profileNameInput} required disabled={busy} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <div className="oauth-model-fields">
      <label className="field">模型 ID<input required disabled={busy} maxLength={256} value={model} onChange={(event) => setModel(event.target.value)} /></label>
      {models.length > 0 && <CustomSelect label="候选模型" disabled={busy} value={models.includes(model) ? model : ""}
        options={[{ value: "", label: "手动输入", meta: "保留当前填写值" }, ...models.map((value) => ({ value, label: value }))]}
        onChange={(value) => { if (value) setModel(value); }} compact wide />}
    </div>
    <div className="oauth-actions"><button className="ghost-button" type="button" disabled={busy} onClick={() => void run("models", async (signal) => {
      const result = await api<{ models: string[]; error: string | null }>(`/api/oauth/accounts/${account.id}/models`, { signal });
      if (signal.aborted) return;
      setModels(result.models);
      if (result.error) throw new Error(result.error);
      setNotice(`已读取 ${result.models.length} 个模型；模型调用尚未验证。`);
    })}>{action === "models" ? "读取中..." : "读取模型目录"}</button></div>
    <div className="oauth-actions"><button className="solid-button" type="submit" disabled={busy || !config}>{action === "create" ? "创建中..." : "创建档案，不应用"}</button><button className="ghost-button" type="button" disabled={busy} onClick={() => setAccountId("")}>取消</button></div>
  </form>;

  return (
    <section className="oauth-panel" aria-labelledby={`${id}-title`}>
      <div className="oauth-heading"><div className="oauth-heading-title"><h3 id={`${id}-title`}>厂商授权连接</h3><span>全局共享 · {OAUTH_PROVIDERS.length} 种接入</span></div>
        <button type="button" className="ghost-button" disabled={loading || busy} onClick={reload}>刷新连接</button>
      </div>
      <p className="oauth-flow-note">授权只新增连接。创建档案后仍需手动应用，不会覆盖当前激活档案。</p>
      <ol className="oauth-steps" aria-label="接入步骤">
        <li><span>01</span>连接厂商账号</li><li><span>02</span>创建客户端档案</li><li><span>03</span>手动应用档案</li>
      </ol>
      <details ref={connectDetails} className="oauth-connect" open={connectOpen} onToggle={(event) => setConnectOpen(event.currentTarget.open)}>
        <summary>添加授权连接</summary>
        <form className="oauth-form" onSubmit={start}>
          <CustomSelect label="模型厂商" value={providerId} options={providerOptions} disabled={busy || pending(session)} wide
            onChange={(value) => {
              const selected = OAUTH_PROVIDERS.find((item) => item.id === value)!;
              setProviderId(selected.id); setMethod(selected.methods[0]); setSession(null); setError(null);
            }} />
          <label className="field">连接名称
            <input maxLength={100} value={label} placeholder={provider.name} disabled={busy || pending(session)} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <div className="oauth-provider-note"><strong className="oauth-provider-mark">{provider.name.split(" · ")[0]}</strong><div><span>{provider.description}</span> <a href={provider.documentation_url} target="_blank" rel="noreferrer">厂商文档</a></div></div>
          <fieldset className="oauth-methods" disabled={busy || pending(session)}><legend>授权方式</legend>
            <div className="toggle-group" role="group" aria-label="授权方式">
              {provider.methods.map((value) => <button key={value} type="button" className={method === value ? "is-active" : ""} aria-pressed={method === value} onClick={() => setMethod(value)}>{methodLabel[value]}</button>)}
            </div>
          </fieldset>
          {providerId === "google-vertex" && <>
            <label className="field">OAuth Client ID<input required disabled={busy || pending(session)} value={clientId} onChange={(event) => setClientId(event.target.value)} /></label>
            <label className="field">OAuth Client Secret<input required disabled={busy || pending(session)} type="password" autoComplete="off" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} /></label>
            <label className="field">Cloud 项目 ID<input required disabled={busy || pending(session)} value={project} onChange={(event) => setProject(event.target.value)} /></label>
            <label className="field">区域<input required disabled={busy || pending(session)} value={location} onChange={(event) => setLocation(event.target.value)} /></label>
          </>}
          <div className="oauth-actions"><button className="solid-button" disabled={busy || pending(session)} type="submit">{action === "start" ? "正在发起授权..." : "开始授权"}</button></div>
        </form>
        {session && <div className="oauth-session" aria-live="polite">
          <strong>{sessionLabel[session.status]}</strong>
          {session.error && <p role="alert" className="error-note">{session.error}</p>}
          {pending(session) && <>
            {session.user_code && <div className="oauth-code"><code>{session.user_code}</code><button type="button" className="ghost-button" onClick={() => void run("copy", async () => { await navigator.clipboard.writeText(session.user_code!); setNotice("设备码已复制。"); })}>复制设备码</button></div>}
            <span>有效期至 {new Date(session.expires_at).toLocaleTimeString()}</span>
            <div className="oauth-actions"><a className="solid-button" href={session.authorization_url} target="_blank" rel="noreferrer">前往厂商授权</a>
              <button type="button" className="ghost-button" disabled={busy} onClick={() => void run("cancel", async (signal) => {
                const next = await api<OAuthSessionView>(`/api/oauth/sessions/${session.id}`, { method: "DELETE", signal });
                if (!signal.aborted) setSession(next);
              })}>取消授权</button>
            </div>
            {session.method === "browser" && <details><summary>手动提交回调</summary>
              <form onSubmit={(event) => {
                event.preventDefault();
                void run("complete", async (signal) => {
                  const next = await api<OAuthSessionView>(`/api/oauth/sessions/${session.id}/complete`, { method: "POST", signal, body: JSON.stringify({ callback_url: callback }) });
                  if (signal.aborted) return;
                  setSession(next); setCallback("");
                  if (next.account_id) { setAccountId(next.account_id); setModels([]); setModel(""); reload(); }
                });
              }}><label className="field">完整回调 URL<input required type="url" value={callback} autoComplete="off" onChange={(event) => setCallback(event.target.value)} /></label>
                <button className="ghost-button" disabled={busy} type="submit">确认回调</button>
              </form>
            </details>}
          </>}
        </div>}
      </details>

      <div className="oauth-list-heading" role="status">{loading ? "正在读取连接..." : accountsError ? "连接读取失败，可刷新重试" : accounts.length === 0 ? "暂无授权连接，从上方添加第一个连接" : `已保存连接 · ${accounts.length}`}</div>
      {accountsError && <p role="alert" className="error-note">{accountsError}</p>}
      <div className="oauth-account-list">{accounts.map((item) => {
        const linked = config?.profiles.filter((profile) => profile.oauth_account_id === item.id || profile.compact_oauth_account_id === item.id) ?? [];
        return <article className="oauth-account" key={item.id}>
          <div className="oauth-account-copy"><strong>{item.label}</strong><span className="oauth-account-provider">{OAUTH_PROVIDERS.find((p) => p.id === item.provider)?.name}</span><small>{item.base_url}</small>
            <small>{linked.length ? `${linked.length} 个档案引用` : "未绑定档案"}{item.expires_at ? ` · 到期 ${new Date(item.expires_at).toLocaleString()}` : " · 无固定到期时间"}</small>
            {item.error && <small className="error-note">{item.error}</small>}
          </div>
          <span className={`oauth-status ${item.status === "connected" ? "is-ready" : item.status === "disconnected" ? "is-muted" : "is-warning"}`}>{oauthStatusLabel[item.status]}</span>
          {linked.length > 0 && <div className="oauth-linked-profiles" aria-label="引用档案">
            {linked.map((profile) => <button key={`${profile.scope}-${profile.id}`} className="oauth-profile-link" type="button"
              aria-label={`定位 ${profile.scope === "codex" ? "Codex" : "Claude"} 档案 ${profile.name}`}
              title="仅定位档案，不选中、不应用，也不更改草稿"
              onClick={() => onProfileLocate(profile.scope, profile.id)}>
              <span>{profile.scope === "codex" ? "Codex" : "Claude"}</span>{profile.name}<span aria-hidden="true">↗</span>
            </button>)}
          </div>}
          <div className="oauth-actions">
            <button className="ghost-button" type="button" disabled={busy || !canUse(item)} aria-expanded={accountId === item.id && canUse(item)} aria-controls={accountId === item.id ? `${id}-profile-form` : undefined} onClick={() => { setAccountId(item.id); setModels([]); setModel(""); setNotice(null); setCreatedProfile(null); }}>创建档案</button>
            {item.can_refresh && <button className="ghost-button" type="button" disabled={busy} onClick={() => void run(`refresh-${item.id}`, async (signal) => {
              try {
                await api(`/api/oauth/accounts/${item.id}/refresh`, { method: "POST", signal });
                if (!signal.aborted) setNotice("授权已刷新。");
              } finally {
                if (!signal.aborted) reload();
              }
            })}>刷新授权</button>}
            {!canUse(item) && <button className="ghost-button" type="button" disabled={busy || pending(session)} onClick={() => {
              const nextProvider = OAUTH_PROVIDERS.find((value) => value.id === item.provider)!;
              setProviderId(item.provider); setMethod(nextProvider.methods[0]); setLabel(item.label); setSession(null); setError(null);
              setNotice("重新授权会创建新连接，原档案需重新绑定。");
              if (connectDetails.current) {
                connectDetails.current.open = true;
                connectDetails.current.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.focus();
              }
            }}>重新授权</button>}
            {item.status !== "disconnected" && <button className="ghost-button profile-danger-button" type="button" disabled={busy} onClick={() => { setError(null); setDisconnectId(item.id); }}>断开</button>}
          </div>
          {item.id === accountId && profileForm}
        </article>;
      })}</div>
      {disconnectAccount && <dialog ref={openDisconnectDialog} className="confirm-panel" role="alertdialog"
        aria-labelledby={`${id}-disconnect-title`} aria-describedby={`${id}-disconnect-desc`}
        onCancel={(event) => { event.preventDefault(); if (!busy) setDisconnectId(null); }}>
        <span className="confirm-icon" aria-hidden="true">!</span>
        <div className="confirm-copy">
          <h2 id={`${id}-disconnect-title`}>断开「{disconnectAccount.label}」？</h2>
          <p id={`${id}-disconnect-desc`}>{config?.profiles.filter((profile) => profile.oauth_account_id === disconnectAccount.id || profile.compact_oauth_account_id === disconnectAccount.id).length ?? 0} 个引用此连接的档案将无法发送新请求。厂商侧授权不会自动撤销。</p>
        </div>
        {error && <p role="alert" className="error-note">{error}</p>}
        <div className="confirm-actions">
          <button className="ghost-button" type="button" disabled={busy} onClick={() => setDisconnectId(null)}>保留连接</button>
          <button className="solid-button danger-solid-button" type="button" disabled={busy} onClick={() => void run(`disconnect-${disconnectAccount.id}`, async (signal) => {
            await api(`/api/oauth/accounts/${disconnectAccount.id}`, { method: "DELETE", signal, body: JSON.stringify({ confirm: true }) });
            if (!signal.aborted) {
              reload();
              if (accountId === disconnectAccount.id) setAccountId("");
              setNotice("本地连接已断开。");
              setDisconnectId(null);
            }
          })}>{busy ? "断开中..." : "确认断开"}</button>
        </div>
      </dialog>}
      <div className="oauth-notice" aria-live="polite">{notice && <p>{notice}</p>}
        {locatedProfile && <button type="button" className="ghost-button" onClick={() => onProfileLocate(locatedProfile.scope, locatedProfile.id)}>定位新档案</button>}
      </div>
      {error && !disconnectAccount && <div role="alert"><p className="error-note">{error}</p><button type="button" className="ghost-button" onClick={() => setError(null)}>{pending(session) ? "重试状态查询" : "关闭提示"}</button></div>}
      <small className="oauth-boundary">Claude.ai 订阅不提供第三方登录接入；Anthropic API 仍使用手动密钥。</small>
    </section>
  );
}
