import { describe, expect, it, vi } from "vitest";
import type { OAuthAccountView, OAuthSessionView } from "../src/shared/oauth.js";
import type { PublicConfig } from "../src/shared/types.js";
import { fetchJson, startApp } from "./helpers/server-test-utils.js";

async function oauthApp() {
  const providerFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ key: "synthetic-router-secret" })));
  const app = await startApp(undefined, undefined, undefined, { fetcher: providerFetch });
  const start = () => fetchJson<OAuthSessionView>(`${app.url}/api/oauth/sessions`, "POST", { provider: "openrouter", method: "browser", label: "Router" });
  const authorize = async () => {
    const { body: session } = await start();
    const callback = new URL(new URL(session.authorization_url).searchParams.get("callback_url")!);
    callback.searchParams.set("code", "synthetic-code");
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("synthetic-router-secret");
    const result = await fetchJson<OAuthSessionView>(`${app.url}/api/oauth/sessions/${session.id}`, "GET");
    expect(result.body.status).toBe("connected");
    return result.body.account_id!;
  };
  return { ...app, providerFetch, start, authorize };
}

describe("OAuth management API", () => {
  it("completes PKCE, creates an inactive profile and never exports subscription credentials", async () => {
    const app = await oauthApp();
    const id = await app.authorize();
    const accounts = await fetchJson<{ accounts: OAuthAccountView[] }>(`${app.url}/api/oauth/accounts`, "GET");
    expect(accounts.response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(accounts.body)).not.toContain("synthetic-router-secret");
    const before = await fetchJson<PublicConfig>(`${app.url}/api/config`, "GET");
    const saved = await fetchJson<PublicConfig>(`${app.url}/api/oauth/profiles`, "POST", {
      account_id: id, name: "OAuth API", model: "provider/model", scope: "codex", revision: before.body.revision
    });
    expect(saved.response.status).toBe(201);
    expect(saved.body.active_profile_id).toBeNull();
    expect(saved.body.profiles[0].oauth_account_id).toBe(id);
    const applied = await fetchJson<PublicConfig>(`${app.url}/api/config/profiles/apply`, "POST", { scope: "codex", profile_id: saved.body.profiles[0].id });
    expect(applied.body.primary).toMatchObject({ api_key_source: "oauth", oauth_status: "connected" });
    const exported = await fetch(`${app.url}/api/config/export`);
    expect(await exported.text()).not.toContain("synthetic-router-secret");
  });

  it("requires confirmation to disconnect and reports disconnected health", async () => {
    const app = await oauthApp();
    const id = await app.authorize();
    await app.config.saveOAuthProfile("codex", id, "OAuth", "model", app.config.revision);
    await app.config.applyProfile("codex", app.config.toPublicConfig().profiles[0].id);
    const denied = await fetchJson(`${app.url}/api/oauth/accounts/${id}`, "DELETE", {});
    expect(denied.response.status).toBe(400);
    const disconnected = await fetchJson<{ account: OAuthAccountView }>(`${app.url}/api/oauth/accounts/${id}`, "DELETE", { confirm: true });
    expect(disconnected.body.account.status).toBe("disconnected");
    const health = await fetchJson<{ primary: { api_key_configured: boolean; oauth_status: string } }>(`${app.url}/api/health`, "GET");
    expect(health.body.primary).toMatchObject({ api_key_configured: false, oauth_status: "disconnected" });
  });

  it("keeps authorization behind the existing cross-site guard", async () => {
    const app = await oauthApp();
    const response = await fetch(`${app.url}/api/oauth/sessions`, {
      method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", label: "Not authorized" })
    });
    expect(response.status).toBe(403);
    expect(app.providerFetch).not.toHaveBeenCalled();
    expect(app.config.oauth.list()).toEqual([]);
  });

  it("cancels an authorization and rejects stale callback replay", async () => {
    const app = await oauthApp();
    const { body: session } = await app.start();
    const cancelled = await fetchJson<OAuthSessionView>(`${app.url}/api/oauth/sessions/${session.id}`, "DELETE");
    expect(cancelled.body.status).toBe("cancelled");
    const callback = new URL(new URL(session.authorization_url).searchParams.get("callback_url")!);
    callback.searchParams.set("code", "synthetic-code");
    expect((await fetch(callback)).status).toBe(400);
    expect(app.providerFetch).not.toHaveBeenCalled();
  });

  it("rejects missing revisions and never reflects malformed credential JSON", async () => {
    const app = await oauthApp();
    const id = await app.authorize();
    const save = await fetchJson(`${app.url}/api/oauth/profiles`, "POST", { account_id: id, name: "No revision", model: "model", scope: "codex" });
    expect(save.response.status).toBe(400);
    const invalid = await fetch(`${app.url}/api/oauth/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"client_secret":"synthetic-do-not-echo",bad}'
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("synthetic-do-not-echo");
  });
});
