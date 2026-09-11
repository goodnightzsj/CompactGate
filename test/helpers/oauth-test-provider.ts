import { vi } from "vitest";
import type { OAuthProviderId } from "../../src/shared/oauth.js";
import type { OAuthStore } from "../../src/server/oauth-store.js";

/** Synthetic issuer only; never calls a provider or reads an installed CLI credential. */
export function oauthTestProvider(provider: OAuthProviderId) {
  let clock = Date.parse("2026-09-08T00:00:00Z");
  let generation = 0;
  const token = () => {
    generation += 1;
    const access = provider === "openai-codex"
      ? `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" }, generation })).toString("base64url")}.signature`
      : `synthetic-${provider}-${generation}`;
    return { access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600, resource_url: "https://portal.qwen.ai" };
  };
  const verification = {
    "qwen-code": "https://chat.qwen.ai/authorize", "kimi-code": "https://auth.kimi.com/device",
    xai: "https://auth.x.ai/device", "github-copilot": "https://github.com/login/device",
    "openai-codex": "https://auth.openai.com/codex/device", "google-vertex": "", openrouter: ""
  }[provider];
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const pathname = new URL(String(url)).pathname;
    const body = pathname.endsWith("/auth/keys") ? { key: "synthetic-openrouter-key" }
      : /\/(?:device\/code|device_authorization|deviceauth\/usercode)$/.test(pathname) ? {
        device_code: "synthetic-device", device_auth_id: "synthetic-device", user_code: "TEST-1234",
        verification_uri: verification, interval: 5, expires_in: 900
      }
        : pathname.endsWith("/deviceauth/token") ? { authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" }
          : pathname === "/copilot_internal/v2/token" ? { token: `synthetic-copilot-${++generation}`, expires_at: clock / 1000 + 3600, endpoints: { api: "https://api.individual.githubcopilot.com" } }
            : /\/(?:token|access_token)$/.test(pathname) ? token()
              : null;
    if (!body) throw new Error(`Unexpected synthetic OAuth endpoint: ${pathname}`);
    return new Response(JSON.stringify(body));
  });
  return {
    fetcher,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    authorize: async (store: OAuthStore) => {
      const method = provider === "openrouter" || provider === "google-vertex" ? "browser" : "device_code";
      const session = await store.start({
        provider, method, label: `Test ${provider}`,
        ...(provider === "google-vertex" ? { settings: {
          client_id: "test.apps.googleusercontent.com", client_secret: "synthetic-client-secret", project_id: "test-project", location: "global"
        } } : {})
      }, "http://127.0.0.1:7865");
      let result;
      if (method === "browser") {
        const auth = new URL(session.authorization_url);
        const callback = new URL(auth.searchParams.get(provider === "openrouter" ? "callback_url" : "redirect_uri")!);
        if (provider !== "openrouter") callback.searchParams.set("state", auth.searchParams.get("state")!);
        callback.searchParams.set("code", "synthetic-code");
        result = await store.complete(session.id, callback.href);
      } else {
        clock += 5000;
        result = await store.poll(session.id);
      }
      if (result.status !== "connected" || !result.account_id) throw new Error(`Synthetic ${provider} authorization failed: ${result.error}`);
      return result.account_id;
    }
  };
}
