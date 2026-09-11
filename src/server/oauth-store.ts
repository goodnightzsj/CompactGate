import http, { type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  OAUTH_PROVIDERS,
  type OAuthAccountStatus,
  type OAuthAccountView,
  type OAuthProviderId,
  type OAuthSessionView,
  type OAuthStartInput
} from "../shared/oauth.js";
import type { UpstreamConfig } from "../shared/types.js";
import { ConfigError, isRecord } from "./config-internals.js";
import { readConfigFile, writeFileAtomically } from "./config-file-repository.js";
import {
  assertTrustedApiUrl,
  beginOAuthFlow,
  CODEX_REDIRECT_URI,
  exchangeOAuthCode,
  OAuthProviderError,
  pollOAuthFlow,
  readOAuthStartInput,
  refreshOAuthTokens,
  requiredString,
  type OAuthFlow,
  type OAuthTokens
} from "./oauth-providers.js";

interface StoredOAuthAccount extends OAuthTokens {
  id: string;
  input: OAuthStartInput;
  state: "active" | "needs_reauth" | "disconnected";
  created_at: string;
  updated_at: string;
  error: string | null;
}

interface OAuthSession {
  id: string;
  input: OAuthStartInput;
  status: OAuthSessionView["status"] | "saving";
  flow: OAuthFlow | null;
  expiresAt: number;
  nextPollAt: number;
  accountId: string | null;
  error: string | null;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  callbackServer?: http.Server;
}

export interface OAuthStoreOptions {
  fetcher?: typeof fetch;
  now?: () => number;
}

/** Owns credentials; ConfigStore only owns references to these connections. */
export class OAuthStore {
  private accounts = new Map<string, StoredOAuthAccount>();
  private readonly sessions = new Map<string, OAuthSession>();
  private readonly refreshes = new Map<string, { controller: AbortController; promise: Promise<OAuthTokens> }>();
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  private constructor(private readonly filePath: string, options: OAuthStoreOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  static async load(configPath: string, options: OAuthStoreOptions = {}): Promise<OAuthStore> {
    const parsed = path.parse(path.resolve(configPath));
    const store = new OAuthStore(path.join(parsed.dir, `${parsed.name}-oauth.json`), options);
    let loaded;
    try { loaded = await readConfigFile(store.filePath); }
    catch { throw new ConfigError("OAuth credential store could not be read. Check its permissions and JSON format."); }
    if (loaded.missing) return store;
    if (!isRecord(loaded.value) || loaded.value.version !== 1 || !Array.isArray(loaded.value.accounts)) {
      throw new ConfigError("OAuth credential store has an unsupported format.");
    }
    for (const raw of loaded.value.accounts) {
      const account = readStoredAccount(raw);
      if (store.accounts.has(account.id)) throw new ConfigError("OAuth credential store contains duplicate connection IDs.");
      store.accounts.set(account.id, account);
    }
    return store;
  }

  list(): OAuthAccountView[] {
    return [...this.accounts.values()].map((account) => this.toView(account));
  }

  get(id: string): OAuthAccountView | null {
    const account = this.accounts.get(id);
    return account ? this.toView(account) : null;
  }

  status(id: string): OAuthAccountStatus {
    return this.get(id)?.status ?? "missing";
  }

  assertBinding(upstream: UpstreamConfig): void {
    if (!upstream.oauth_account_id) return;
    const account = this.accounts.get(upstream.oauth_account_id);
    // Portable configs keep dangling references so they can be explicitly
    // reconnected on the destination. The request boundary fails closed.
    if (!account) return;
    const provider = providerInfo(account.input.provider);
    if (upstream.upstream_protocol !== provider.protocol || normalizeBase(upstream.base_url) !== normalizeBase(account.base_url)) {
      throw new ConfigError("OAuth connection URL and protocol are managed by its provider. Select the connection again or switch to manual credentials.");
    }
  }

  async start(value: unknown, origin: string, signal?: AbortSignal): Promise<OAuthSessionView> {
    this.assertOpen();
    const input = readOAuthStartInput(value);
    const originUrl = new URL(origin);
    if (!/^https?:$/.test(originUrl.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(originUrl.hostname) || originUrl.username || originUrl.password) {
      throw new ConfigError("OAuth callbacks require a loopback Studio URL.");
    }
    if ([...this.sessions.values()].filter((item) => isPending(item)).length >= 8) {
      throw new ConfigError("Too many pending OAuth sessions. Cancel an existing session first.", 409);
    }
    const id = randomBytes(24).toString("base64url");
    const session: OAuthSession = {
      id, input, status: "pending", flow: null, expiresAt: this.now() + 10 * 60_000,
      nextPollAt: 0, accountId: null, error: null, controller: new AbortController(),
      timer: setTimeout(() => this.expire(id), 10 * 60_000)
    };
    session.timer.unref();
    this.sessions.set(id, session);
    const cancelStart = () => {
      if (isPending(session)) this.finish(session, "cancelled");
    };
    signal?.addEventListener("abort", cancelStart, { once: true });
    if (signal?.aborted) cancelStart();
    try {
      this.assertPending(session);
      const callback = new URL(`/api/oauth/callback/${id}`, originUrl.origin).href;
      const flow = await beginOAuthFlow(input, callback, this.fetcher, session.controller.signal, this.now());
      this.assertPending(session);
      session.flow = flow;
      session.expiresAt = flow.expires_at;
      session.nextPollAt = this.now() + flow.interval_ms;
      clearTimeout(session.timer);
      session.timer = setTimeout(() => this.expire(id), Math.max(1, flow.expires_at - this.now()));
      session.timer.unref();
      if (input.provider === "openai-codex" && input.method === "browser") {
        await this.listenForCodex(session);
        this.assertPending(session);
      }
      return this.sessionView(session);
    } catch (error) {
      if (isPending(session)) this.finish(session, "error", safeOAuthError(error));
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelStart);
    }
  }

  session(id: string): OAuthSessionView {
    return this.sessionView(this.requireSession(id));
  }

  cancel(id: string): OAuthSessionView {
    const session = this.requireSession(id);
    if (session.status === "saving") {
      throw new ConfigError("OAuth connection is being committed. Wait for the result before disconnecting it.", 409);
    }
    if (isPending(session)) this.finish(session, "cancelled");
    return this.sessionView(session);
  }

  async poll(id: string): Promise<OAuthSessionView> {
    const session = this.requireSession(id);
    if (session.status !== "pending" || session.input.method !== "device_code" || this.now() < session.nextPollAt) {
      return this.sessionView(session);
    }
    this.assertPending(session);
    const flow = session.flow!;
    session.status = "exchanging";
    session.nextPollAt = this.now() + flow.interval_ms;
    try {
      const result = await pollOAuthFlow(flow, this.fetcher, session.controller.signal, this.now());
      this.assertPending(session);
      if (result === "pending" || "retry_interval_ms" in result) {
        if (result !== "pending") flow.interval_ms = result.retry_interval_ms;
        session.nextPollAt = this.now() + flow.interval_ms;
        session.status = "pending";
      } else {
        await this.saveSession(session, result);
      }
    } catch (error) {
      if (isPending(session)) this.finish(session, "error", safeOAuthError(error));
    }
    return this.sessionView(session);
  }

  async complete(id: string, callbackUrl: string): Promise<OAuthSessionView> {
    const session = this.requireSession(id);
    if (session.input.method !== "browser" || session.status !== "pending" || !session.flow) {
      throw new ConfigError("OAuth callback is no longer pending. Start a new authorization.", 409);
    }
    const callback = new URL(callbackUrl);
    const expected = new URL(session.flow.redirect_uri);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname ||
      callback.searchParams.getAll("state").length !== 1 || !equalSecret(callback.searchParams.get("state"), session.flow.state)) {
      throw new ConfigError("OAuth callback state or redirect URL did not match.", 400);
    }
    if (callback.searchParams.has("error")) {
      this.finish(session, "error", "Authorization was denied. No connection was saved.");
      return this.sessionView(session);
    }
    if (callback.searchParams.getAll("code").length !== 1) throw new ConfigError("OAuth callback requires one authorization code.");
    const code = requiredString(callback.searchParams.get("code"), "authorization code");
    session.status = "exchanging";
    try {
      const tokens = await exchangeOAuthCode(session.flow, code, this.fetcher, session.controller.signal, this.now());
      this.assertPending(session);
      await this.saveSession(session, tokens);
    } catch (error) {
      if (isPending(session)) this.finish(session, "error", safeOAuthError(error));
    }
    return this.sessionView(session);
  }

  async credentials(id: string): Promise<OAuthTokens & { provider: OAuthProviderId }> {
    this.assertOpen();
    const account = this.requireUsableAccount(id);
    if (account.expires_at !== null && account.expires_at <= this.now() + 60_000) {
      await this.refresh(id);
    }
    const current = this.requireUsableAccount(id);
    return { ...tokensOf(current), provider: current.input.provider };
  }

  refresh(id: string): Promise<OAuthTokens> {
    this.assertOpen();
    const existing = this.refreshes.get(id);
    if (existing) return existing.promise;
    const account = this.requireUsableAccount(id);
    if (!account.refresh_token) throw new ConfigError("This connection does not support token refresh. Its existing authorization is unchanged.");
    const controller = new AbortController();
    const promise = this.refreshAccount(account, controller.signal).finally(() => {
      if (this.refreshes.get(id)?.controller === controller) this.refreshes.delete(id);
    });
    this.refreshes.set(id, { controller, promise });
    return promise;
  }

  async disconnect(id: string): Promise<void> {
    this.assertOpen();
    if (!this.accounts.has(id)) throw new ConfigError("OAuth connection was not found.", 404);
    this.refreshes.get(id)?.controller.abort();
    await this.mutate((current) => {
      const account = current.get(id)!;
      const next = new Map(current);
      next.set(id, {
        ...account, access_token: "", refresh_token: "", state: "disconnected", error: null,
        input: { provider: account.input.provider, method: account.input.method, label: account.input.label },
        updated_at: new Date(this.now()).toISOString()
      });
      return next;
    });
  }

  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) {
      clearTimeout(session.timer);
      session.controller.abort();
      session.callbackServer?.close();
    }
    for (const refresh of this.refreshes.values()) refresh.controller.abort();
    this.sessions.clear();
  }

  private async refreshAccount(account: StoredOAuthAccount, signal: AbortSignal): Promise<OAuthTokens> {
    try {
      const tokens = await refreshOAuthTokens(account.input, tokensOf(account), this.fetcher, signal, this.now());
      await this.mutate((current) => {
        if (signal.aborted || current.get(account.id) !== account) {
          throw new ConfigError("OAuth connection changed while refreshing. No stale credentials were saved.", 409);
        }
        // A new resource endpoint must be explicitly rebound by the operator;
        // never make a stored URL silently point at another destination.
        if (normalizeBase(tokens.base_url) !== normalizeBase(account.base_url)) {
          throw new OAuthProviderError("OAuth provider changed its API endpoint. Authorize a new connection.", true, 401);
        }
        const next = new Map(current);
        next.set(account.id, { ...account, ...tokens, updated_at: new Date(this.now()).toISOString(), error: null });
        return next;
      });
      return tokens;
    } catch (error) {
      if (!signal.aborted && this.accounts.get(account.id) === account) {
        await this.mutate((current) => {
          if (current.get(account.id) !== account) return current;
          const next = new Map(current);
          next.set(account.id, {
            ...account,
            state: error instanceof OAuthProviderError && error.reauthRequired ? "needs_reauth" : account.state,
            error: safeOAuthError(error), updated_at: new Date(this.now()).toISOString()
          });
          return next;
        });
      }
      throw error;
    }
  }

  private async saveSession(session: OAuthSession, tokens: OAuthTokens): Promise<void> {
    this.assertPending(session);
    const timestamp = new Date(this.now()).toISOString();
    const account: StoredOAuthAccount = {
      ...tokens, id: randomUUID(), input: session.input, state: "active",
      created_at: timestamp, updated_at: timestamp, error: null
    };
    await this.mutate((current) => {
      this.assertPending(session);
      // From this atomic commit point, cancellation becomes disconnection.
      session.status = "saving";
      const next = new Map(current);
      next.set(account.id, account);
      return next;
    });
    session.accountId = account.id;
    this.finish(session, "connected");
  }

  private mutate(build: (current: Map<string, StoredOAuthAccount>) => Map<string, StoredOAuthAccount>): Promise<void> {
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      this.assertOpen();
      const next = build(this.accounts);
      if (next === this.accounts) return;
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFileAtomically(this.filePath, `${JSON.stringify({ version: 1, accounts: [...next.values()] }, null, 2)}\n`);
      this.accounts = next;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async listenForCodex(session: OAuthSession): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.method !== "GET" || !req.url?.startsWith("/auth/callback?")) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, CODEX_REDIRECT_URI);
      void this.complete(session.id, url.href).then((result) => {
        sendOAuthCallbackPage(res, result.status === "connected");
      }, () => sendOAuthCallbackPage(res, false));
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 5000;
    session.callbackServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new ConfigError("Codex callback port 1455 is unavailable. Finish the other login or use device code authorization.", 409)));
      server.listen(1455, "127.0.0.1", () => { server.unref(); resolve(); });
    });
  }

  private requireSession(id: string): OAuthSession {
    this.assertOpen();
    const session = this.sessions.get(id);
    if (!session) throw new ConfigError("OAuth session was not found or has expired.", 404);
    if (isPending(session) && this.now() >= session.expiresAt && session.status !== "saving") this.finish(session, "expired");
    return session;
  }

  private assertPending(session: OAuthSession): void {
    this.assertOpen();
    if (this.now() >= session.expiresAt && session.status !== "saving") this.finish(session, "expired");
    if (!isPending(session) || session.controller.signal.aborted) throw new ConfigError("OAuth authorization is no longer pending.", 409);
  }

  private assertOpen(): void {
    if (this.closed) throw new ConfigError("OAuth service is closed.", 503);
  }

  private requireUsableAccount(id: string): StoredOAuthAccount {
    const account = this.accounts.get(id);
    if (!account || account.state !== "active" || !account.access_token) {
      throw new OAuthProviderError("OAuth connection is missing, disconnected or requires authorization. Reconnect it in Profiles.", true, 401);
    }
    return account;
  }

  private finish(session: OAuthSession, status: OAuthSessionView["status"], error: string | null = null): void {
    session.status = status;
    session.error = error;
    session.controller.abort();
    session.callbackServer?.close();
    // Device codes, PKCE verifiers and client secrets never survive the flow.
    session.flow = null;
    session.input = { provider: session.input.provider, method: session.input.method, label: session.input.label };
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.sessions.delete(session.id), 5 * 60_000);
    session.timer.unref();
  }

  private expire(id: string): void {
    const session = this.sessions.get(id);
    if (session && isPending(session) && session.status !== "saving") this.finish(session, "expired");
  }

  private sessionView(session: OAuthSession): OAuthSessionView {
    return {
      id: session.id, provider: session.input.provider, method: session.input.method,
      status: session.status === "saving" ? "exchanging" : session.status,
      authorization_url: session.flow?.authorization_url ?? "",
      user_code: session.flow?.user_code ?? null, expires_at: new Date(session.expiresAt).toISOString(),
      poll_after_ms: Math.max(1000, session.nextPollAt - this.now()),
      account_id: session.accountId, error: session.error
    };
  }

  private toView(account: StoredOAuthAccount): OAuthAccountView {
    return {
      id: account.id, provider: account.input.provider, label: account.input.label,
      base_url: account.base_url, upstream_protocol: providerInfo(account.input.provider).protocol,
      status: account.state !== "active" ? account.state
        : account.expires_at !== null && account.expires_at <= this.now() ? "expired" : "connected",
      expires_at: account.expires_at === null ? null : new Date(account.expires_at).toISOString(),
      created_at: account.created_at, updated_at: account.updated_at,
      can_refresh: account.state === "active" && Boolean(account.refresh_token), error: account.error
    };
  }
}

function tokensOf(account: StoredOAuthAccount): OAuthTokens {
  return {
    access_token: account.access_token, refresh_token: account.refresh_token,
    expires_at: account.expires_at, base_url: account.base_url,
    ...(account.provider_account_id ? { provider_account_id: account.provider_account_id } : {})
  };
}

function readStoredAccount(raw: unknown): StoredOAuthAccount {
  if (!isRecord(raw) || !isRecord(raw.input) || !["active", "needs_reauth", "disconnected"].includes(String(raw.state))) {
    throw new ConfigError("OAuth credential store contains an invalid connection.");
  }
  const provider = providerInfo(raw.input.provider as OAuthProviderId);
  const method = raw.input.method;
  if ((method !== "browser" && method !== "device_code") || !provider.methods.includes(method)) {
    throw new ConfigError("OAuth credential store contains an invalid method.");
  }
  const input: OAuthStartInput = raw.state === "disconnected"
    ? { provider: provider.id, method, label: requiredString(raw.input.label, "label", 100) }
    : readOAuthStartInput(raw.input);
  const id = requiredString(raw.id, "connection ID", 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ConfigError("Invalid OAuth connection ID.");
  const baseUrl = requiredString(raw.base_url, "base_url");
  assertTrustedApiUrl(input.provider, new URL(baseUrl));
  const expiresAt = raw.expires_at;
  if (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime()))) {
    throw new ConfigError("OAuth credential store contains an invalid expiration.");
  }
  if (input.provider !== "openrouter" && expiresAt === null) throw new ConfigError("OAuth token expiration is required.");
  const createdAt = requiredString(raw.created_at, "created_at", 64);
  const updatedAt = requiredString(raw.updated_at, "updated_at", 64);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new ConfigError("Invalid OAuth connection timestamps.");
  return {
    id, input, state: raw.state as StoredOAuthAccount["state"],
    access_token: raw.state === "disconnected" ? "" : requiredString(raw.access_token, "access_token"),
    refresh_token: raw.state === "disconnected" || input.provider === "openrouter" ? "" : requiredString(raw.refresh_token, "refresh_token"),
    expires_at: expiresAt, base_url: baseUrl, created_at: createdAt, updated_at: updatedAt,
    ...(input.provider === "openai-codex" ? { provider_account_id: requiredString(raw.provider_account_id, "provider_account_id", 256) } : {}),
    // Do not trust a manually edited file to inject secret text into public errors.
    error: raw.error ? "The last OAuth refresh failed. Retry or authorize a new connection." : null
  };
}

function providerInfo(id: OAuthProviderId) {
  const provider = OAUTH_PROVIDERS.find((item) => item.id === id);
  if (!provider) throw new ConfigError("Unsupported OAuth provider.");
  return provider;
}

function isPending(session: OAuthSession): boolean {
  return session.status === "pending" || session.status === "exchanging" || session.status === "saving";
}

function equalSecret(value: string | null, expected: string): boolean {
  if (value === null) return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function normalizeBase(value: string): string {
  return new URL(value).href.replace(/\/+$/, "");
}

function safeOAuthError(error: unknown): string {
  return error instanceof ConfigError ? error.message : "OAuth connection could not be saved. Check the server storage and retry.";
}

export function sendOAuthCallbackPage(res: ServerResponse, success: boolean): void {
  res.writeHead(success ? 200 : 400, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CompactGate 授权</title><style>body{font:16px/1.6 system-ui;background:#f6f3ec;color:#292820;margin:10vh auto;padding:24px;max-width:560px}h1{font-size:24px}p{color:#615e55}</style><h1>${success ? "连接已授权" : "授权未完成"}</h1><p>${success ? "请返回 CompactGate 的档案页面继续。授权不会自动切换当前运行配置。" : "请返回 CompactGate 查看状态或重新发起授权。"}</p><p>现在可以关闭此页面。</p></html>`);
}
