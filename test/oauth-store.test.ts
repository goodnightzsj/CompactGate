import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthStore } from "../src/server/oauth-store.js";
import { beginOAuthFlow, exchangeOAuthCode, requestOAuthJson } from "../src/server/oauth-providers.js";
import type { OAuthProviderId } from "../src/shared/oauth.js";
import * as repository from "../src/server/config-file-repository.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const stores: OAuthStore[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); vi.restoreAllMocks(); });

const token = (fields = {}) => ({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, resource_url: "https://portal.qwen.ai", ...fields });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function fixture(provider: OAuthProviderId = "qwen-code") {
  let now = Date.parse("2026-09-08T00:00:00Z");
  const dir = await makeConfigDir();
  const configPath = path.join(dir, "compactgate.json");
  const verification = {
    "qwen-code": "https://chat.qwen.ai/authorize", "kimi-code": "https://auth.kimi.com/device",
    xai: "https://auth.x.ai/device", "github-copilot": "https://github.com/login/device",
    "openai-codex": "https://auth.openai.com/codex/device", openrouter: "", "google-vertex": ""
  }[provider];
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
    device_code: "synthetic-device-secret", device_auth_id: "synthetic-device-id", user_code: "ABCD-1234",
    verification_uri: verification, interval: 5, expires_in: 900
  }));
  const store = await OAuthStore.load(configPath, { fetcher, now: () => now });
  stores.push(store);
  const start = () => store.start({ provider, method: "device_code", label: "Test connection" }, "http://127.0.0.1:7865");
  return {
    store, fetcher, dir, configPath, start,
    advance: (ms: number) => { now += ms; }, now: () => now,
    connect: async () => {
      const session = await start();
      now += 5000;
      fetcher.mockResolvedValueOnce(json(token()));
      const result = await store.poll(session.id);
      expect(result.status).toBe("connected");
      return result.account_id!;
    }
  };
}

describe("OAuth connection lifecycle", () => {
  it("stores private credentials separately and exposes no token, verifier or device secret", async () => {
    const f = await fixture();
    const started = await f.start();
    expect(JSON.stringify(started)).not.toContain("synthetic-device-secret");
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json(token()));
    const completed = await f.store.poll(started.id);
    expect(completed).toMatchObject({ status: "connected", authorization_url: "", user_code: null });
    expect(f.store.get(completed.account_id!)?.base_url).toBe("https://portal.qwen.ai/v1");
    expect(JSON.stringify(f.store.list())).not.toMatch(/synthetic-(access|refresh|device)|client_secret|code_verifier/);
    const file = path.join(f.dir, "compactgate-oauth.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain("synthetic-refresh");
    const reloaded = await OAuthStore.load(f.configPath, { fetcher: f.fetcher, now: f.now });
    stores.push(reloaded);
    expect(reloaded.list()).toEqual(f.store.list());
    expect((await reloaded.credentials(completed.account_id!)).access_token).toBe("synthetic-access");
  });

  it("honors polling intervals, pending and slow_down without parallel token exchanges", async () => {
    const f = await fixture();
    const started = await f.start();
    await f.store.poll(started.id);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json({ error: "slow_down" }, 400));
    expect(await f.store.poll(started.id)).toMatchObject({ status: "pending", poll_after_ms: 10_000 });
    f.advance(5000);
    await f.store.poll(started.id);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json({ error: "authorization_pending" }, 400));
    const results = await Promise.all([f.store.poll(started.id), f.store.poll(started.id)]);
    expect(results.some((result) => result.status === "pending")).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([30, 2])("honors slow_down interval %s without reducing the required backoff", async (interval) => {
    const f = await fixture("github-copilot");
    const started = await f.start();
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json({ error: "slow_down", interval }, 400));
    const wait = Math.max(10_000, interval * 1000);
    expect(await f.store.poll(started.id)).toMatchObject({ status: "pending", poll_after_ms: wait });
    f.advance(wait - 1);
    await f.store.poll(started.id);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance(1);
    f.fetcher.mockResolvedValueOnce(json({ error: "authorization_pending" }, 400));
    expect(await f.store.poll(started.id)).toMatchObject({ status: "pending", poll_after_ms: wait });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([0, -1, "30"])("rejects invalid slow_down interval %s", async (interval) => {
    const f = await fixture();
    const started = await f.start();
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json({ error: "slow_down", interval }, 400));
    expect(await f.store.poll(started.id)).toMatchObject({ status: "error", error: "Invalid OAuth field: interval." });
    expect(f.store.list()).toHaveLength(0);
  });

  it("cancellation wins over a late token response", async () => {
    const f = await fixture();
    const started = await f.start();
    f.advance(5000);
    let release!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const polling = f.store.poll(started.id);
    expect(f.store.cancel(started.id).status).toBe("cancelled");
    release(json(token()));
    expect((await polling).status).toBe("cancelled");
    expect(f.store.list()).toEqual([]);
    await expect(stat(path.join(f.dir, "compactgate-oauth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires sessions without another network call and rejects callback replay", async () => {
    const f = await fixture();
    const started = await f.start();
    f.advance(900_001);
    expect((await f.store.poll(started.id)).status).toBe("expired");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await expect(f.store.complete(started.id, "http://127.0.0.1/callback?code=x")).rejects.toMatchObject({ status: 409 });
  });

  it("reports denial and malformed provider data without echoing secrets", async () => {
    const f = await fixture();
    const started = await f.start();
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json({ error: "access_denied", error_description: "synthetic-private-value" }, 400));
    const result = await f.store.poll(started.id);
    expect(result.status).toBe("error");
    expect(result.error).toContain("denied");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
    expect(f.store.list()).toHaveLength(0);
  });

  it.each(["javascript:alert(1)", "https://evil.example/authorize", "https://chat.qwen.ai.evil.example/authorize"])("rejects untrusted verification URL %s", async (url) => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(json({ device_code: "secret", user_code: "CODE", verification_uri: url, expires_in: 900 }));
    await expect(f.start()).rejects.toThrow(/untrusted/);
  });

  it("rejects untrusted token resource endpoints and malformed expirations", async () => {
    for (const fields of [{ resource_url: "https://evil.example" }, { expires_in: -1 }, { expires_in: "3600" }]) {
      const f = await fixture();
      const started = await f.start();
      f.advance(5000);
      f.fetcher.mockResolvedValueOnce(json(token(fields)));
      expect((await f.store.poll(started.id)).status).toBe("error");
      expect(f.store.list()).toHaveLength(0);
    }
  });

  it("does not publish a connection when persistence fails", async () => {
    const f = await fixture();
    const started = await f.start();
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json(token()));
    vi.spyOn(repository, "writeFileAtomically").mockRejectedValueOnce(new Error("synthetic disk failure"));
    expect((await f.store.poll(started.id)).status).toBe("error");
    expect(f.store.list()).toHaveLength(0);
  });

  it("deduplicates concurrent refreshes and keeps an omitted refresh token", async () => {
    const f = await fixture();
    const id = await f.connect();
    f.advance(3_550_000);
    f.fetcher.mockResolvedValueOnce(json({ access_token: "synthetic-new", expires_in: 3600 }));
    const credentials = await Promise.all([f.store.credentials(id), f.store.credentials(id), f.store.credentials(id)]);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(credentials.every((item) => item.access_token === "synthetic-new" && item.refresh_token === "synthetic-refresh")).toBe(true);
  });

  it("disconnect prevents an in-flight refresh from restoring credentials", async () => {
    const f = await fixture();
    const id = await f.connect();
    let release!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const refresh = f.store.refresh(id).catch((error: unknown) => error);
    await f.store.disconnect(id);
    release(json(token({ access_token: "synthetic-late" })));
    await refresh;
    expect(f.store.status(id)).toBe("disconnected");
    await expect(f.store.credentials(id)).rejects.toMatchObject({ status: 401 });
    const persisted = await readFile(path.join(f.dir, "compactgate-oauth.json"), "utf8");
    expect(persisted).not.toMatch(/synthetic-(access|refresh|late)/);
  });

  it("marks revoked refresh grants as requiring reauthorization", async () => {
    const f = await fixture();
    const id = await f.connect();
    f.fetcher.mockResolvedValueOnce(json({ error: "invalid_grant", access_token: "synthetic-leak" }, 400));
    await expect(f.store.refresh(id)).rejects.toMatchObject({ status: 401 });
    expect(f.store.get(id)).toMatchObject({ status: "needs_reauth", can_refresh: false });
    expect(JSON.stringify(f.store.list())).not.toContain("synthetic-leak");
    await expect(f.store.credentials(id)).rejects.toMatchObject({ status: 401 });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not replace a corrupt credential store with an empty success", async () => {
    const f = await fixture();
    const file = path.join(f.dir, "compactgate-oauth.json");
    await writeFile(file, '{"synthetic-private":broken', { mode: 0o600 });
    await expect(OAuthStore.load(f.configPath)).rejects.toThrow("could not be read");
    expect(await readFile(file, "utf8")).toContain("synthetic-private");
  });
});

describe("browser PKCE and provider-specific grants", () => {
  it("OpenRouter binds state, redirect and PKCE, consumes the code once and does not claim refresh support", async () => {
    const f = await fixture("openrouter");
    const started = await f.store.start({ provider: "openrouter", method: "browser", label: "Router" }, "http://127.0.0.1:7865");
    const auth = new URL(started.authorization_url);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(auth.searchParams.get("callback_url")!);
    callback.searchParams.set("code", "synthetic-code");
    const bad = new URL(callback);
    bad.searchParams.set("state", "wrong");
    await expect(f.store.complete(started.id, bad.href)).rejects.toThrow(/state/);
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(json({ key: "synthetic-router-key" }));
    const complete = await f.store.complete(started.id, callback.href);
    expect(complete.status).toBe("connected");
    expect(f.store.get(complete.account_id!)).toMatchObject({ can_refresh: false, expires_at: null });
    await expect(f.store.complete(started.id, callback.href)).rejects.toMatchObject({ status: 409 });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string);
    expect(sent).toMatchObject({ code: "synthetic-code", code_challenge_method: "S256" });
    expect(sent.code_verifier).toHaveLength(43);
    expect(() => f.store.refresh(complete.account_id!)).toThrow(/does not support/);
    expect(f.store.get(complete.account_id!)).toMatchObject({ status: "connected", can_refresh: false });
    expect((await f.store.credentials(complete.account_id!)).access_token).toBe("synthetic-router-key");
  });

  it("Google uses the operator's own OAuth client and binds the Cloud project endpoint", async () => {
    const f = await fixture("google-vertex");
    const started = await f.store.start({
      provider: "google-vertex", method: "browser", label: "Gemini",
      settings: { client_id: "synthetic.apps.googleusercontent.com", client_secret: "synthetic-client-secret", project_id: "test-project", location: "global" }
    }, "http://127.0.0.1:7865");
    const auth = new URL(started.authorization_url);
    expect(auth.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(auth.searchParams.get("access_type")).toBe("offline");
    expect(started.authorization_url).not.toContain("synthetic-client-secret");
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    callback.searchParams.set("code", "synthetic-code");
    f.fetcher.mockResolvedValueOnce(json(token()));
    const complete = await f.store.complete(started.id, callback.href);
    expect(f.store.get(complete.account_id!)?.base_url).toBe("https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi");
    expect(JSON.stringify(f.store.list())).not.toContain("synthetic-client-secret");
    await f.store.disconnect(complete.account_id!);
    expect(await readFile(path.join(f.dir, "compactgate-oauth.json"), "utf8")).not.toContain("synthetic-client-secret");
  });

  it("Codex device grant performs the second code exchange and captures account routing metadata", async () => {
    const f = await fixture("openai-codex");
    const started = await f.start();
    f.advance(5000);
    const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
    f.fetcher.mockResolvedValueOnce(json({ authorization_code: "code", code_verifier: "provider-verifier" }))
      .mockResolvedValueOnce(json(token({ access_token: access })));
    const result = await f.store.poll(started.id);
    expect(result.status).toBe("connected");
    expect((await f.store.credentials(result.account_id!)).provider_account_id).toBe("synthetic-account");
    expect(String(f.fetcher.mock.calls[2]![1]?.body)).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
  });

  it.each([[403, null], [404, "not authorized yet"]] as const)("keeps Codex HTTP %s pending without requiring JSON, then completes authorization", async (status, body) => {
    const f = await fixture("openai-codex");
    const started = await f.start();
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(new Response(body, { status }));
    expect(await f.store.poll(started.id)).toMatchObject({ status: "pending", error: null, poll_after_ms: 5000 });
    expect(f.store.list()).toHaveLength(0);
    const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json({ authorization_code: "code", code_verifier: "provider-verifier" }))
      .mockResolvedValueOnce(json(token({ access_token: access })));
    expect(await f.store.poll(started.id)).toMatchObject({ status: "connected", error: null });
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  it("accepts the Codex usercode alias but keeps other providers' required field strict", async () => {
    for (const provider of ["openai-codex", "qwen-code"] as const) {
      const f = await fixture(provider);
      f.fetcher.mockResolvedValueOnce(json({ device_auth_id: "synthetic-device", device_code: "synthetic-device", usercode: "CODE-1234", interval: 5 }));
      if (provider === "openai-codex") expect(await f.start()).toMatchObject({ status: "pending", user_code: "CODE-1234" });
      else await expect(f.start()).rejects.toThrow("Invalid OAuth field: user_code.");
    }
  });

  it("Codex browser authorization uses the registered loopback callback and PKCE", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(token()));
    const signal = new AbortController().signal;
    const flow = await beginOAuthFlow({ provider: "openai-codex", method: "browser", label: "Codex" }, "http://127.0.0.1:7865/api/oauth/callback/id", fetcher, signal, Date.now());
    expect(new URL(flow.authorization_url).searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    await expect(exchangeOAuthCode(flow, "code", fetcher, signal, Date.now())).rejects.toThrow(/account claim/);
  });

  it.each(["kimi-code", "xai"] as const)("supports %s device and refresh grants", async (provider) => {
    const f = await fixture(provider);
    const id = await f.connect();
    f.fetcher.mockResolvedValueOnce(json(token({ access_token: "synthetic-rotated" })));
    expect((await f.store.refresh(id)).access_token).toBe("synthetic-rotated");
    expect(String(f.fetcher.mock.calls[2]![1]?.body)).toContain("grant_type=refresh_token");
  });

  it("Copilot exchanges GitHub tokens, honors the trusted endpoint and never changes model policy", async () => {
    const f = await fixture("github-copilot");
    const started = await f.start();
    f.advance(5000);
    f.fetcher.mockResolvedValueOnce(json({ access_token: "synthetic-github-token" }))
      .mockResolvedValueOnce(json({ token: "tid=test;proxy-ep=proxy.individual.githubcopilot.com;", expires_at: f.now() / 1000 + 3600 }));
    const result = await f.store.poll(started.id);
    expect(result.status).toBe("connected");
    expect(f.store.get(result.account_id!)?.base_url).toBe("https://api.individual.githubcopilot.com");
    expect((await f.store.credentials(result.account_id!)).refresh_token).toBe("synthetic-github-token");
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes("/policy"))).toBe(false);
  });

  it("sanitizes invalid JSON and bounds response size", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("synthetic-secret: not-json"))
      .mockResolvedValueOnce(new Response("x".repeat(1_048_577)));
    await expect(requestOAuthJson(fetcher, "https://auth.x.ai/oauth2/token", new AbortController().signal)).rejects.toThrow("invalid JSON");
    await expect(requestOAuthJson(fetcher, "https://auth.x.ai/oauth2/token", new AbortController().signal)).rejects.toThrow("size limit");
  });
});
