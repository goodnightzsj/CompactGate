import type { OAuthProviderId } from "../shared/oauth.js";
import type { UpstreamConfig } from "../shared/types.js";
import { ConfigError } from "./config-internals.js";
import { factoryClientUserAgent } from "./config-defaults.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";
import { COPILOT_HEADERS, OAuthProviderError } from "./oauth-providers.js";
import type { OAuthStore } from "./oauth-store.js";
import { requestJson, UpstreamStatusError } from "./upstream-json-client.js";
import { extractModelIds, type UpstreamModelsResponse } from "./upstream-models.js";

interface OAuthRequest {
  upstream: URL;
  requestHeaders: Record<string, string>;
  upstreamBody: Buffer;
}

/** Apply provider credentials only after routing/conversion, at the send boundary. */
export async function prepareOAuthRequest(
  route: UpstreamConfig,
  oauth: OAuthStore | undefined,
  request: OAuthRequest,
  method = "POST"
): Promise<OAuthProviderId | null> {
  if (!route.oauth_account_id) return null;
  if (!oauth) throw new OAuthProviderError("OAuth service is unavailable for this request.", false, 503);
  oauth.assertBinding(route);
  const account = oauth.get(route.oauth_account_id);
  if (!account) throw new OAuthProviderError("OAuth connection is missing. Reconnect it in Profiles.", true, 401);
  const base = new URL(account.base_url);
  const prefix = base.pathname.replace(/\/+$/, "");
  const relativePath = request.upstream.pathname.slice(prefix.length);
  const paths = account.provider === "openai-codex"
    ? ["/responses", "/responses/compact", "/models"]
    : account.provider === "kimi-code"
      ? ["/v1/messages", "/v1/messages/count_tokens", "/v1/models"]
      : ["/chat/completions", "/models"];
  if (request.upstream.origin !== base.origin || !request.upstream.pathname.startsWith(prefix) ||
    request.upstream.username || request.upstream.password || request.upstream.hash || !paths.includes(relativePath) ||
    (relativePath.endsWith("/models") ? method !== "GET" : method !== "POST")) {
    throw new ConfigError("This OAuth provider does not support the requested endpoint or method. Use its supported model protocol.");
  }
  const tokens = await oauth.credentials(route.oauth_account_id);
  const headers = request.requestHeaders;
  // A caller's API key, tenant, or cookie must never accompany a different account.
  for (const name of Object.keys(headers)) {
    if (["authorization", "api-key", "x-api-key", "anthropic-api-key", "x-anthropic-api-key", "x-goog-api-key",
      "cookie", "openai-organization", "openai-project", "chatgpt-account-id", "x-goog-user-project"].includes(name.toLowerCase())) {
      delete headers[name];
    }
  }
  headers.authorization = `Bearer ${tokens.access_token}`;
  headers["accept-encoding"] = "identity";
  if (tokens.provider === "openai-codex") {
    headers["chatgpt-account-id"] = tokens.provider_account_id!;
    headers.originator = "codex-tui";
    headers["openai-beta"] = "responses=experimental";
    if (method === "POST") {
      request.upstreamBody = codexRequestBody(request.upstreamBody, relativePath === "/responses/compact");
      headers.accept = relativePath === "/responses/compact" ? "application/json" : "text/event-stream";
      delete headers["content-encoding"];
    }
  } else if (tokens.provider === "github-copilot") {
    Object.assign(headers, COPILOT_HEADERS);
    const body = parseJsonRecord(request.upstreamBody);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const last = messages.at(-1);
    headers["x-initiator"] = isRecord(last) && last.role !== "user" ? "agent" : "user";
    headers["openai-intent"] = "conversation-edits";
    delete headers["copilot-vision-request"];
    if (messages.some((message) => isRecord(message) && Array.isArray(message.content) &&
      message.content.some((part: unknown) => isRecord(part) && part.type === "image_url"))) {
      headers["copilot-vision-request"] = "true";
    }
  } else if (tokens.provider === "kimi-code") {
    headers["anthropic-version"] ||= "2023-06-01";
  }
  return tokens.provider;
}

function codexRequestBody(raw: Buffer, compact: boolean): Buffer {
  const body = parseJsonRecord(raw);
  if (!body) throw new ConfigError("Codex OAuth requests require a JSON object.");
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== "string") {
    throw new ConfigError("Codex instructions must be a string.");
  }
  body.instructions ??= "";
  if (typeof body.input === "string") {
    body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }];
  }
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item: unknown) => {
      if (!isRecord(item)) return item;
      const next: Record<string, unknown> = { ...item, ...(item.role === "system" ? { role: "developer" } : {}) };
      if (Array.isArray(next.content)) next.content = next.content.map((part: unknown) => {
        if (!isRecord(part) || !("prompt_cache_breakpoint" in part)) return part;
        const copy = { ...part };
        delete copy.prompt_cache_breakpoint;
        return copy;
      });
      return next;
    });
  }
  // Codex's subscription wire contract differs from the Platform Responses API.
  // Confirmed against CLIProxyAPI's Codex translator; provider-state items stay intact.
  for (const field of ["max_output_tokens", "max_completion_tokens", "temperature", "top_p", "truncation",
    "prompt_cache_options", "prompt_cache_retention", "user", "stream_options", "safety_identifier"]) delete body[field];
  if (body.context_management !== undefined) {
    throw new ConfigError("Codex OAuth does not support Platform context_management. Use native Codex compaction instead.");
  }
  if (compact) {
    delete body.stream;
    delete body.store;
  } else {
    body.stream = true;
    body.store = false;
    const include = Array.isArray(body.include) ? body.include : [];
    body.include = [...new Set([...include, "reasoning.encrypted_content"])];
  }
  return Buffer.from(JSON.stringify(body));
}

export async function fetchOAuthModels(
  route: UpstreamConfig,
  oauth: OAuthStore | undefined,
  timeoutMs: number,
  userAgent?: string | null
): Promise<UpstreamModelsResponse> {
  const upstreamHost = new URL(route.base_url).host;
  try {
    const account = oauth?.get(route.oauth_account_id ?? "");
    if (!account) throw new OAuthProviderError("OAuth connection is missing. Reconnect it in Profiles.", true, 401);
    if (account.provider === "google-vertex") {
      return { models: [], upstream_host: upstreamHost, error: "Vertex 的 OpenAI 兼容接口不提供账号模型目录，请按 Cloud 项目中启用的模型填写 ID（google/模型ID）。" };
    }
    const upstream = new URL(`${route.base_url.replace(/\/+$/, "")}${account.provider === "kimi-code" ? "/v1/models" : "/models"}`);
    const request: OAuthRequest = {
      upstream, upstreamBody: Buffer.alloc(0),
      requestHeaders: { accept: "application/json", ...(userAgent ? { "user-agent": userAgent } : {}), ...route.extra_headers }
    };
    await prepareOAuthRequest(route, oauth, request, "GET");
    if (account.provider === "openai-codex") {
      // Same local identity baseline used by ordinary model discovery.
      const version = /\/(\d+\.\d+\.\d+)/.exec(userAgent || factoryClientUserAgent("codex"))?.[1];
      if (version) upstream.searchParams.set("client_version", version);
    }
    const body = await requestJson(upstream, request.requestHeaders, Math.min(timeoutMs, 30_000), { proxyUrl: route.proxy_url });
    const models = oauthModelIds(account.provider, body);
    return { models, upstream_host: upstreamHost, error: models.length ? null : "厂商未返回当前连接可用的模型，请检查账号权限或手动填写模型 ID。" };
  } catch (error) {
    return { models: [], upstream_host: upstreamHost, error: error instanceof ConfigError ? error.message
      : error instanceof UpstreamStatusError ? `OAuth 模型列表请求失败（HTTP ${error.status}），请检查账号权限。`
        : "OAuth 模型列表请求失败，请检查网络与厂商服务后重试。" };
  }
}

function oauthModelIds(provider: OAuthProviderId, value: unknown): string[] {
  if (!isRecord(value)) throw new OAuthProviderError("OAuth provider returned an invalid model catalog.");
  const data = provider === "openai-codex" ? value.models : value.data;
  if (!Array.isArray(data)) throw new OAuthProviderError("OAuth provider returned an invalid model catalog.");
  if (provider === "openai-codex") {
    return extractModelIds(data.filter((item) => isRecord(item) && item.visibility !== "hide")
      .map((item) => isRecord(item) ? item.slug : null));
  }
  if (provider === "github-copilot") {
    return extractModelIds(data.filter((item) => isRecord(item) &&
      (!isRecord(item.policy) || item.policy.state !== "disabled") &&
      (!Array.isArray(item.supported_endpoints) || item.supported_endpoints.includes("/chat/completions"))));
  }
  return extractModelIds(data);
}
