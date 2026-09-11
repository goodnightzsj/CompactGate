import { createHash, randomBytes } from "node:crypto";
import {
  OAUTH_PROVIDERS,
  type OAuthProviderId,
  type OAuthStartInput
} from "../shared/oauth.js";
import { ConfigError, isRecord } from "./config-internals.js";

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  base_url: string;
  provider_account_id?: string;
}

export interface OAuthFlow {
  input: OAuthStartInput;
  verifier: string;
  state: string;
  redirect_uri: string;
  authorization_url: string;
  device_code: string;
  user_code: string | null;
  interval_ms: number;
  expires_at: number;
}

export interface OAuthHttpResponse {
  status: number;
  body: Record<string, unknown>;
}

export class OAuthProviderError extends ConfigError {
  constructor(message: string, readonly reauthRequired = false, status = 502) {
    super(message, status);
  }
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEVICE_REDIRECT = "https://auth.openai.com/deviceauth/callback";

// Public OAuth application identifiers from the providers' published clients.
const DEVICE_PROVIDERS = {
  "qwen-code": {
    client_id: "f0304373b74a44d2b584a3fb70ca9e56",
    scope: "openid profile email model.completion",
    device_url: "https://chat.qwen.ai/api/v1/oauth2/device/code",
    token_url: "https://chat.qwen.ai/api/v1/oauth2/token"
  },
  "kimi-code": {
    client_id: "17e5f671-d194-4dfb-9706-5516cb48c098", scope: "",
    device_url: "https://auth.kimi.com/api/oauth/device_authorization",
    token_url: "https://auth.kimi.com/api/oauth/token"
  },
  xai: {
    client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    scope: "openid profile email offline_access grok-cli:access api:access",
    device_url: "https://auth.x.ai/oauth2/device/code",
    token_url: "https://auth.x.ai/oauth2/token"
  },
  "github-copilot": {
    client_id: "Iv1.b507a08c87ecfe98", scope: "read:user",
    device_url: "https://github.com/login/device/code",
    token_url: "https://github.com/login/oauth/access_token"
  }
} as const;

export const COPILOT_HEADERS = {
  "user-agent": "GitHubCopilotChat/0.35.0",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "copilot-integration-id": "vscode-chat",
  "x-github-api-version": "2026-06-01"
};

export function readOAuthStartInput(value: unknown): OAuthStartInput {
  if (!isRecord(value)) throw new ConfigError("OAuth connection requires a JSON object.");
  const provider = OAUTH_PROVIDERS.find((item) => item.id === value.provider);
  if (!provider) throw new ConfigError("Unsupported OAuth provider.");
  const method = value.method ?? provider.methods[0];
  if (method !== "browser" && method !== "device_code" || !provider.methods.includes(method)) {
    throw new ConfigError("Unsupported OAuth authorization method.");
  }
  const label = requiredString(value.label, "label", 100).trim();
  if (!label) throw new ConfigError("OAuth connection label is required.");
  const input: OAuthStartInput = { provider: provider.id, method, label };
  if (provider.id === "google-vertex") {
    const settings = isRecord(value.settings) ? value.settings : {};
    const clientId = requiredString(settings.client_id, "client_id", 256).trim();
    if (!/^[a-zA-Z0-9.-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      throw new ConfigError("Google OAuth requires your Desktop app client_id.");
    }
    const projectId = requiredString(settings.project_id, "project_id", 63).trim();
    const location = settings.location === undefined ? "global" : requiredString(settings.location, "location", 63).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(projectId) || !/^[a-z][a-z0-9-]*$/.test(location)) {
      throw new ConfigError("Google project_id or location is invalid.");
    }
    input.settings = {
      client_id: clientId,
      client_secret: requiredString(settings.client_secret, "client_secret", 512),
      project_id: projectId,
      location
    };
  }
  return input;
}

export async function requestOAuthJson(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  body?: URLSearchParams | Record<string, string>,
  headers: Record<string, string> = {},
  statusOnly: readonly number[] = []
): Promise<OAuthHttpResponse> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: body ? "POST" : "GET",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": body instanceof URLSearchParams
          ? "application/x-www-form-urlencoded" : "application/json" } : {}),
        ...headers
      },
      body: body instanceof URLSearchParams ? body : body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    });
    if (statusOnly.includes(response.status)) {
      await response.body?.cancel();
      return { status: response.status, body: {} };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new OAuthProviderError("OAuth provider returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          await reader.cancel();
          throw new OAuthProviderError("OAuth provider response exceeded the size limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new OAuthProviderError(`OAuth provider returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!isRecord(json)) throw new OAuthProviderError("OAuth provider returned an invalid response object.");
    return { status: response.status, body: json };
  } catch (error) {
    if (error instanceof OAuthProviderError) throw error;
    if (signal.aborted) throw new ConfigError("OAuth request was cancelled or expired.", 409);
    // Provider bodies and fetch errors may echo secrets or URLs with credentials.
    throw new OAuthProviderError("OAuth provider request failed or timed out. Check network connectivity.");
  }
}

export async function beginOAuthFlow(
  input: OAuthStartInput,
  callbackUrl: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  now: number
): Promise<OAuthFlow> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const flow: OAuthFlow = {
    input, verifier, state,
    redirect_uri: input.provider === "openai-codex" ? CODEX_REDIRECT_URI : callbackUrl,
    authorization_url: "", device_code: "", user_code: null,
    interval_ms: 5000, expires_at: now + 10 * 60_000
  };
  if (input.method === "browser") {
    if (input.provider === "openrouter") {
      const callback = new URL(callbackUrl);
      callback.searchParams.set("state", state);
      flow.redirect_uri = callback.href;
      const url = new URL("https://openrouter.ai/auth");
      url.search = new URLSearchParams({
        callback_url: callback.href, code_challenge: challenge, code_challenge_method: "S256"
      }).toString();
      flow.authorization_url = url.href;
    } else {
      const google = input.provider === "google-vertex";
      const url = new URL(google ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://auth.openai.com/oauth/authorize");
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: google ? input.settings!.client_id! : CODEX_CLIENT_ID,
        redirect_uri: flow.redirect_uri,
        scope: google ? "https://www.googleapis.com/auth/cloud-platform" : "openid profile email offline_access",
        code_challenge: challenge, code_challenge_method: "S256", state,
        ...(google ? { access_type: "offline", prompt: "consent" } : {
          id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "compactgate"
        })
      }).toString();
      flow.authorization_url = url.href;
    }
    return flow;
  }

  let response: OAuthHttpResponse;
  if (input.provider === "openai-codex") {
    response = await requestOAuthJson(fetcher, "https://auth.openai.com/api/accounts/deviceauth/usercode", signal, { client_id: CODEX_CLIENT_ID });
  } else {
    const settings = DEVICE_PROVIDERS[input.provider as keyof typeof DEVICE_PROVIDERS];
    response = await requestOAuthJson(fetcher, settings.device_url, signal, new URLSearchParams({
      client_id: settings.client_id,
      ...(settings.scope ? { scope: settings.scope } : {}),
      ...(input.provider === "qwen-code" ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
      ...(input.provider === "xai" ? { referrer: "compactgate" } : {})
    }));
  }
  requireOAuthSuccess(response);
  const data = response.body;
  const codex = input.provider === "openai-codex";
  flow.device_code = requiredString(data[codex ? "device_auth_id" : "device_code"], "device_code");
  flow.user_code = requiredString(codex ? data.user_code ?? data.usercode : data.user_code, "user_code", 256);
  const verification = codex ? "https://auth.openai.com/codex/device"
    : data.verification_uri_complete ?? data.verification_uri;
  flow.authorization_url = trustedVerificationUrl(input.provider, requiredString(verification, "verification_uri"));
  const interval = typeof data.interval === "string" && codex ? Number(data.interval) : data.interval;
  if (interval !== undefined && (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0)) {
    throw new OAuthProviderError("OAuth provider returned an invalid polling interval.");
  }
  flow.interval_ms = Math.min(900_000, Math.max(1000, (interval as number | undefined ?? 5) * 1000));
  const expires = codex ? 900 : positiveSeconds(data.expires_in, "expires_in");
  flow.expires_at = now + Math.min(expires, 900) * 1000;
  return flow;
}

export async function pollOAuthFlow(
  flow: OAuthFlow, fetcher: typeof fetch, signal: AbortSignal, now: number
): Promise<OAuthTokens | "pending" | { retry_interval_ms: number }> {
  let response: OAuthHttpResponse;
  if (flow.input.provider === "openai-codex") {
    response = await requestOAuthJson(fetcher, "https://auth.openai.com/api/accounts/deviceauth/token", signal, {
      device_auth_id: flow.device_code, user_code: flow.user_code!
    }, {}, [403, 404]);
    if (response.status === 403 || response.status === 404) return "pending";
  } else {
    const settings = DEVICE_PROVIDERS[flow.input.provider as keyof typeof DEVICE_PROVIDERS];
    response = await requestOAuthJson(fetcher, settings.token_url, signal, new URLSearchParams({
      client_id: settings.client_id, device_code: flow.device_code, grant_type: DEVICE_GRANT,
      ...(flow.input.provider === "qwen-code" ? { code_verifier: flow.verifier } : {})
    }));
  }
  const code = response.body.error;
  if (code === "authorization_pending" || code === "deviceauth_authorization_pending") return "pending";
  if (code === "slow_down") {
    const interval = response.body.interval;
    return { retry_interval_ms: Math.max(flow.interval_ms + 5000,
      interval === undefined ? 0 : positiveSeconds(interval, "interval") * 1000) };
  }
  requireOAuthSuccess(response);
  if (flow.input.provider === "openai-codex") {
    return exchangeOAuthCode({ ...flow, verifier: requiredString(response.body.code_verifier, "code_verifier"), redirect_uri: CODEX_DEVICE_REDIRECT },
      requiredString(response.body.authorization_code, "authorization_code"), fetcher, signal, now);
  }
  if (flow.input.provider === "github-copilot") {
    return exchangeCopilotToken(requiredString(response.body.access_token, "access_token"), fetcher, signal, now);
  }
  return tokensFromResponse(flow.input, response.body, now);
}

export async function exchangeOAuthCode(
  flow: OAuthFlow, code: string, fetcher: typeof fetch, signal: AbortSignal, now: number
): Promise<OAuthTokens> {
  const provider = flow.input.provider;
  if (provider === "openrouter") {
    const response = await requestOAuthJson(fetcher, "https://openrouter.ai/api/v1/auth/keys", signal, {
      code, code_verifier: flow.verifier, code_challenge_method: "S256"
    });
    requireOAuthSuccess(response);
    return { access_token: requiredString(response.body.key, "key"), refresh_token: "", expires_at: null, base_url: "https://openrouter.ai/api/v1" };
  }
  const google = provider === "google-vertex";
  const response = await requestOAuthJson(fetcher, google ? "https://oauth2.googleapis.com/token" : "https://auth.openai.com/oauth/token", signal, new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: flow.redirect_uri, code_verifier: flow.verifier,
    client_id: google ? flow.input.settings!.client_id! : CODEX_CLIENT_ID,
    ...(google ? { client_secret: flow.input.settings!.client_secret! } : {})
  }));
  requireOAuthSuccess(response);
  return tokensFromResponse(flow.input, response.body, now);
}

export async function refreshOAuthTokens(
  input: OAuthStartInput, tokens: OAuthTokens, fetcher: typeof fetch, signal: AbortSignal, now: number
): Promise<OAuthTokens> {
  if (!tokens.refresh_token) throw new OAuthProviderError("This connection cannot refresh. Authorize a new connection.", true, 401);
  if (input.provider === "github-copilot") return exchangeCopilotToken(tokens.refresh_token, fetcher, signal, now);
  const google = input.provider === "google-vertex";
  const codex = input.provider === "openai-codex";
  const settings = !google && !codex ? DEVICE_PROVIDERS[input.provider as keyof typeof DEVICE_PROVIDERS] : null;
  const url = google ? "https://oauth2.googleapis.com/token" : codex ? "https://auth.openai.com/oauth/token" : settings!.token_url;
  const response = await requestOAuthJson(fetcher, url, signal, new URLSearchParams({
    grant_type: "refresh_token", refresh_token: tokens.refresh_token,
    client_id: google ? input.settings!.client_id! : codex ? CODEX_CLIENT_ID : settings!.client_id,
    ...(google ? { client_secret: input.settings!.client_secret! } : {})
  }));
  requireOAuthSuccess(response);
  return tokensFromResponse(input, response.body, now, tokens);
}

function tokensFromResponse(input: OAuthStartInput, data: Record<string, unknown>, now: number, previous?: OAuthTokens): OAuthTokens {
  const access = requiredString(data.access_token, "access_token");
  if (data.token_type !== undefined && (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")) {
    throw new OAuthProviderError("OAuth provider returned an unsupported token type.");
  }
  const refresh = data.refresh_token === undefined && previous ? previous.refresh_token
    : requiredString(data.refresh_token, "refresh_token");
  const expires = input.provider === "xai" && data.expires_in === undefined ? 3600 : positiveSeconds(data.expires_in, "expires_in");
  let baseUrl: string;
  let providerAccountId: string | undefined;
  switch (input.provider) {
    case "openai-codex": {
      let claims: unknown;
      try { claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")); }
      catch { throw new OAuthProviderError("Codex access token has no readable account claim."); }
      // Routing metadata from a token returned by the trusted token endpoint,
      // not an authorization decision based on an unverified inbound JWT.
      const auth = isRecord(claims) ? claims["https://api.openai.com/auth"] : null;
      providerAccountId = requiredString(isRecord(auth) ? auth.chatgpt_account_id : null, "chatgpt_account_id", 256);
      if (previous?.provider_account_id && previous.provider_account_id !== providerAccountId) {
        throw new OAuthProviderError("Codex refresh changed account identity. Authorize a new connection.", true, 401);
      }
      baseUrl = "https://chatgpt.com/backend-api/codex";
      break;
    }
    case "google-vertex": {
      const { project_id: project, location = "global" } = input.settings!;
      const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
      baseUrl = `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
      break;
    }
    case "qwen-code": {
      const resource = data.resource_url === undefined ? previous?.base_url ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"
        : requiredString(data.resource_url, "resource_url");
      const url = new URL(resource.includes("://") ? resource : `https://${resource}`);
      assertTrustedApiUrl("qwen-code", url);
      const pathname = url.pathname.replace(/\/+$/, "");
      url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
      baseUrl = url.href.replace(/\/$/, "");
      break;
    }
    case "kimi-code": baseUrl = "https://api.kimi.com/coding"; break;
    case "xai": baseUrl = "https://api.x.ai/v1"; break;
    default: throw new OAuthProviderError("Unsupported token response provider.");
  }
  return { access_token: access, refresh_token: refresh, expires_at: now + expires * 1000, base_url: baseUrl,
    ...(providerAccountId ? { provider_account_id: providerAccountId } : {}) };
}

async function exchangeCopilotToken(githubToken: string, fetcher: typeof fetch, signal: AbortSignal, now: number): Promise<OAuthTokens> {
  const response = await requestOAuthJson(fetcher, "https://api.github.com/copilot_internal/v2/token", signal, undefined, {
    ...COPILOT_HEADERS, authorization: `Bearer ${githubToken}`
  });
  requireOAuthSuccess(response);
  const access = requiredString(response.body.token, "token");
  const expiresAt = positiveSeconds(response.body.expires_at, "expires_at") * 1000;
  if (expiresAt <= now) throw new OAuthProviderError("Copilot returned an expired token.");
  const endpoints = isRecord(response.body.endpoints) ? response.body.endpoints : {};
  const proxyHost = /(?:^|;)proxy-ep=([^;]+)/.exec(access)?.[1];
  const base = endpoints.api ?? (proxyHost ? `https://${proxyHost.replace(/^proxy\./, "api.")}` : "https://api.individual.githubcopilot.com");
  const url = new URL(requiredString(base, "Copilot API endpoint"));
  assertTrustedApiUrl("github-copilot", url);
  if (url.pathname !== "/") throw new OAuthProviderError("Copilot returned an unsupported API path.");
  return { access_token: access, refresh_token: githubToken, expires_at: expiresAt, base_url: url.origin };
}

export function assertTrustedApiUrl(provider: OAuthProviderId, url: URL): void {
  const host = url.hostname;
  const trusted = provider === "qwen-code"
    ? ["portal.qwen.ai", "chat.qwen.ai", "dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(host)
    : provider === "github-copilot" ? /^api(?:\.[a-z0-9-]+)*\.githubcopilot\.com$/.test(host)
    : provider === "openai-codex" ? host === "chatgpt.com"
    : provider === "google-vertex" ? /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(host)
    : provider === "kimi-code" ? host === "api.kimi.com"
    : provider === "xai" ? host === "api.x.ai" : host === "openrouter.ai";
  if (!trusted || url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) {
    throw new OAuthProviderError("OAuth API endpoint is outside the trusted provider boundary.");
  }
}

function trustedVerificationUrl(provider: OAuthProviderId, value: string): string {
  const url = new URL(value);
  const hosts: Partial<Record<OAuthProviderId, string[]>> = {
    "openai-codex": ["auth.openai.com"], "qwen-code": ["chat.qwen.ai"],
    "kimi-code": ["auth.kimi.com", "www.kimi.com", "kimi.com"],
    xai: ["auth.x.ai", "accounts.x.ai", "x.ai"], "github-copilot": ["github.com"]
  };
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts[provider]?.includes(url.hostname)) {
    throw new OAuthProviderError("OAuth provider returned an untrusted authorization URL.");
  }
  return url.href;
}

export function requireOAuthSuccess(response: OAuthHttpResponse): void {
  const code = response.body.error;
  if (response.status >= 200 && response.status < 300 && code === undefined) return;
  if (code === "access_denied" || code === "authorization_denied") {
    throw new OAuthProviderError("Authorization was denied. No connection was saved.", false, 400);
  }
  if (code === "expired_token") throw new OAuthProviderError("Authorization expired. Start a new connection.", false, 400);
  if (code === "invalid_grant" || response.status === 401 || response.status === 403) {
    throw new OAuthProviderError("Authorization is invalid or unavailable for this account. Authorize again and check provider permissions.", true, 401);
  }
  throw new OAuthProviderError(`OAuth provider rejected the request (HTTP ${response.status}). Check provider access and retry.`);
}

export function requiredString(value: unknown, field: string, maxLength = 32_768): string {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OAuthProviderError(`Invalid OAuth field: ${field}.`, false, 400);
  }
  return value;
}

function positiveSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value * 1000 > Number.MAX_SAFE_INTEGER) {
    throw new OAuthProviderError(`Invalid OAuth field: ${field}.`);
  }
  return value;
}
