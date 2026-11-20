import path from "node:path";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { OAuthStore } from "../src/server/oauth-store.js";
import * as repository from "../src/server/config-file-repository.js";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";
import { postJson, startApp, waitForLogEntry } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

it.each(["cancel", "expire", "close"])("does not treat queued authorization %s as a persistence failure", async action => {
  const issuer = oauthTestProvider("qwen-code");
  const store = await OAuthStore.load(path.join(await makeConfigDir(), "synthetic.json"), issuer);
  const account = await issuer.authorize(store);
  const write = repository.writeFileAtomically;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(repository, "writeFileAtomically").mockImplementationOnce(async (...args) => { entered(); await gate; return write(...args); });
  const disconnect = store.disconnect(account);
  await started;
  const session = await store.start({ provider: "qwen-code", method: "device_code", label: "Synthetic queued authorization" }, "http://127.0.0.1:1");
  issuer.advance(5000);
  const poll = store.poll(session.id);
  await nextTurn();
  if (action === "cancel") expect(store.cancel(session.id).status).toBe("cancelled");
  if (action === "expire") issuer.advance(900_000);
  if (action === "close") store.close();
  release();
  await disconnect;
  const result = await poll;
  expect(result.account_id).toBeNull();
  expect(result.status).toBe(action === "cancel" ? "cancelled" : action === "expire" ? "expired" : "error");
  store.close();
  await expect(store.flush()).resolves.toBeUndefined();
});

it.each(["disconnect", "write-failure"])("drains an accepted refresh while preserving %s", async scenario => {
  const configPath = path.join(await makeConfigDir(), "synthetic.json");
  const issuer = oauthTestProvider("qwen-code");
  const store = await OAuthStore.load(configPath, issuer);
  const accountA = await issuer.authorize(store);
  const accountB = await issuer.authorize(store);
  const write = repository.writeFileAtomically;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fault = new Error("synthetic rotated credential write failed");
  const writing = vi.spyOn(repository, "writeFileAtomically").mockImplementationOnce(async (...args) => {
    entered(); await gate; return write(...args);
  });
  const first = store.disconnect(accountB);
  await started;
  issuer.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "synthetic-rotated-access",
    refresh_token: "synthetic-rotated-refresh", expires_in: 3600, resource_url: "https://portal.qwen.ai" })));
  const refresh = store.refresh(accountA).catch(error => error);
  await nextTurn();
  const disconnected = scenario === "disconnect" ? store.disconnect(accountA) : Promise.resolve();
  if (scenario === "write-failure") writing.mockRejectedValueOnce(fault);
  store.close();
  const flushed = store.flush();
  const assertion = scenario === "write-failure" ? expect(flushed).rejects.toBe(fault) : expect(flushed).resolves.toBeUndefined();
  release();
  await Promise.all([first, disconnected, assertion]);
  expect(await refresh).toBeInstanceOf(Error);
  const saved = JSON.parse(await readFile(path.join(path.dirname(configPath), "synthetic-oauth.json"), "utf8"));
  if (scenario === "disconnect") expect(saved.accounts.find((account: { id: string }) => account.id === accountA))
    .toMatchObject({ state: "disconnected", access_token: "", refresh_token: "" });
});

it("cancels a pending exchange and rejects new work while draining shutdown", async () => {
  const issuer = oauthTestProvider("qwen-code");
  const store = await OAuthStore.load(path.join(await makeConfigDir(), "synthetic.json"), issuer);
  const id = await issuer.authorize(store);
  issuer.fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("synthetic cancelled exchange")), { once: true });
  }));
  const refresh = store.refresh(id).catch(error => error);
  store.close();
  await expect(store.flush()).resolves.toBeUndefined();
  expect(await refresh).toBeInstanceOf(Error);
  expect(() => store.refresh(id)).toThrow("OAuth service is closed.");
});

it("does not hide a write failure when disconnect cancels an already committing refresh", async () => {
  const issuer = oauthTestProvider("qwen-code");
  const store = await OAuthStore.load(path.join(await makeConfigDir(), "synthetic.json"), issuer);
  const id = await issuer.authorize(store);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fault = new Error("synthetic active refresh write failed");
  vi.spyOn(repository, "writeFileAtomically").mockImplementationOnce(async () => { entered(); await gate; throw fault; });
  issuer.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "synthetic-rotated-access",
    refresh_token: "synthetic-rotated-refresh", expires_in: 3600, resource_url: "https://portal.qwen.ai" })));
  const refresh = store.refresh(id).catch(error => error);
  await started;
  const disconnect = store.disconnect(id);
  store.close();
  const assertion = expect(store.flush()).rejects.toBe(fault);
  release();
  await Promise.all([disconnect, assertion]);
  expect(await refresh).toBe(fault);
  expect(store.status(id)).toBe("disconnected");
});

it.each([false, true])("keeps completed refresh rotation through a queued write, close-before-drain=%s", async closeBeforeDrain => {
  const dir = await makeConfigDir();
  const configPath = path.join(dir, "compactgate.json");
  const issuer = oauthTestProvider("qwen-code");
  const store = await OAuthStore.load(configPath, issuer);
  const accountA = await issuer.authorize(store);
  const accountB = await issuer.authorize(store);
  const write = repository.writeFileAtomically;
  let entered!: () => void;
  const hasEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(repository, "writeFileAtomically").mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return write(...args);
  });
  const disconnect = store.disconnect(accountB);
  await hasEntered;
  issuer.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
    access_token: "synthetic-rotated-access", refresh_token: "synthetic-rotated-refresh",
    expires_in: 3600, resource_url: "https://portal.qwen.ai"
  })));
  let refreshError: unknown;
  const refresh = store.refresh(accountA).catch(error => { refreshError = error; });
  await nextTurn();
  if (closeBeforeDrain) store.close();
  release();
  await Promise.all([disconnect, refresh, store.flush()]);
  store.close();
  const saved = JSON.parse(await readFile(path.join(dir, "compactgate-oauth.json"), "utf8"));
  expect(saved.accounts.find((account: { id: string }) => account.id === accountB).state).toBe("disconnected");
  expect({ refreshError: refreshError instanceof Error ? refreshError.message : null,
    refreshToken: saved.accounts.find((account: { id: string }) => account.id === accountA).refresh_token })
    .toEqual({ refreshError: null, refreshToken: "synthetic-rotated-refresh" });
});

it.each([false, true])("retains rotated credentials after request timeout and HTTP shutdown, close-before-drain=%s", async closeBeforeDrain => {
  const issuer = oauthTestProvider("qwen-code");
  const app = await startApp(undefined, undefined, { timeouts: { primary_ms: 50 }, primary_failover: { auto_schedule: false } }, issuer);
  const accountA = await issuer.authorize(app.config.oauth);
  const accountB = await issuer.authorize(app.config.oauth);
  await app.config.saveOAuthProfile("codex", accountA, "Synthetic", "synthetic-model", app.config.revision);
  await app.config.applyProfile("codex", app.config.toPublicConfig().profiles[0].id);
  issuer.advance(3_550_000);
  const outbound = vi.spyOn(https, "request").mockImplementation(() => { throw new Error("Unexpected real outbound request"); });
  const write = repository.writeFileAtomically;
  let entered!: () => void;
  const hasEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(repository, "writeFileAtomically").mockImplementationOnce(async (...args) => {
    entered(); await gate; return write(...args);
  });
  const disconnect = app.config.oauth.disconnect(accountB);
  await hasEntered;
  issuer.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
    access_token: "synthetic-rotated-access", refresh_token: "synthetic-rotated-refresh", expires_in: 3600,
    resource_url: "https://portal.qwen.ai"
  })));
  const refreshCalls = vi.spyOn(app.config.oauth, "refresh");
  const response = await postJson(app.url, "/v1/chat/completions", { model: "synthetic-model", messages: [{ role: "user", content: "synthetic" }] });
  let shutdown: Promise<void> | undefined;
  try {
    const body = await response.json() as { request_id: string };
    expect(response.status).toBe(502);
    await waitForLogEntry(app.url, entry => entry.request_id === body.request_id);
    expect(refreshCalls).toHaveBeenCalledTimes(1);
    if (closeBeforeDrain) {
      let closing!: () => void;
      const hasClosed = new Promise<void>(resolve => { closing = resolve; });
      const close = app.config.oauth.close.bind(app.config.oauth);
      vi.spyOn(app.config.oauth, "close").mockImplementation(() => { close(); closing(); });
      shutdown = app.close();
      await hasClosed;
    }
  } finally { release(); }
  const refresh = refreshCalls.mock.results[0].value.catch(() => undefined);
  await Promise.all([disconnect, refresh]);
  await (shutdown ?? app.close());
  expect(outbound).not.toHaveBeenCalled();
  const saved = JSON.parse(await readFile(path.join(app.dir, "compactgate-oauth.json"), "utf8"));
  expect(saved.accounts.find((account: { id: string }) => account.id === accountA).refresh_token)
    .toBe("synthetic-rotated-refresh");
});
