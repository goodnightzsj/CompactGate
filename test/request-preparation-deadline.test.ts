import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import https from "node:https";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import { prepareOAuthRequest, fetchOAuthModels } from "../src/server/oauth-transport.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { ClaudeKeyPoolState } from "../src/server/claude-key-pool.js";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
afterEach(() => vi.restoreAllMocks());
import { postJson, startApp, startUpstream, writeJsonResponse } from "./helpers/server-test-utils.js";

it.each(["/v1/responses", "/v1/responses/compact", "/anthropic/v1/messages"])(
  "settles the total request deadline while the body remains incomplete: %s", async route => {
    let outbound = 0;
    const upstream = await startUpstream((_req, res) => {
      outbound += 1;
      writeJsonResponse(res, { output: [] });
    });
    const app = await startApp(upstream.url, upstream.url, {
      timeouts: { primary_ms: 100, compact_ms: 100, claude_ms: 100 },
      claude: { primary: { base_url: upstream.url, api_key: "synthetic" } }
    });
    const body = JSON.stringify({ model: "synthetic", input: "hello", max_tokens: 20,
      messages: [{ role: "user", content: "hello" }] });
    let settled = false;
    let send!: http.ClientRequest;
    const response = new Promise<number>((resolve, reject) => {
      send = http.request(`${app.url}${route}`, { method: "POST", headers: {
        "content-type": "application/json", "content-length": String(Buffer.byteLength(body))
      } }, res => {
        settled = true;
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      });
      send.once("error", reject);
      send.write(body.slice(0, 1));
    });
    await delay(300);
    const settledByDeadline = settled;
    send.end(body.slice(1));
    const status = await response;
    expect(status).toBe(502);
    expect(outbound).toBe(0);
    expect(settledByDeadline).toBe(true);
  }
);

it.each(['primary', 'compact', 'claude', 'probe', 'models'] as const)('settles the %s deadline while its OAuth refresh is still pending', async (route) => {
  const issuer = oauthTestProvider('openai-codex');
  const app = await startApp(undefined, undefined, {
    primary_failover: { auto_schedule: false }, compact: { upstream_mode: 'primary' },
    timeouts: { primary_ms: 1000, compact_ms: 1000, claude_ms: 1000 }
  }, issuer);
  const accountId = await issuer.authorize(app.config.oauth);
  const scope = route === 'claude' ? 'claude' : 'codex';
  await app.config.saveOAuthProfile(scope, accountId, 'Synthetic', 'fixture', app.config.revision);
  await app.config.applyProfile(scope, app.config.toPublicConfig().profile_scopes[scope].profiles[0].id);
  issuer.advance(3_550_000);
  const tokenFetcher = issuer.fetcher.getMockImplementation()!;
  let release!: () => void;
  let entered!: () => void;
  const hasEntered = new Promise<void>(resolve => { entered = resolve; });
  const refreshGate = new Promise<void>(resolve => { release = resolve; });
  issuer.fetcher.mockImplementationOnce(async (...args) => { entered(); await refreshGate; return tokenFetcher(...args); });
  const outbound = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected real outbound request'); });
  const results = vi.spyOn(route === 'claude' ? ClaudeKeyPoolState.prototype : PrimaryFailoverState.prototype, 'recordResult');
  const path = route === 'claude' ? '/anthropic/v1/messages' : route === 'compact' ? '/v1/responses/compact'
    : route === 'probe' ? '/api/compact/capability-probe' : '/v1/responses';
  let settled = false;
  const request = route === 'models'
    ? fetchOAuthModels(app.config.get().primary, app.config.oauth, 1000).then(body => { settled = true; return { status: 200, body: JSON.stringify(body) }; })
    : postJson(app.url, path, { model: 'fixture', input: 'hi', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] })
      .then(async response => { const body = await response.text(); settled = true; return { status: response.status, body }; });
  await hasEntered;
  await delay(1400);
  const settledByDeadline = settled;
  release();
  const response = await request;
  expect(outbound).not.toHaveBeenCalled();
  expect(response.status).toBe(route === 'probe' || route === 'models' ? 200 : 502);
  if (route === 'probe') expect(JSON.parse(response.body).supported).toBe(false);
  if (route === 'models') expect(JSON.parse(response.body).error).toBeTruthy();
  if (route === 'primary' || route === 'compact' || route === 'claude') expect(results).toHaveBeenCalledTimes(1);
  expect(results.mock.calls.every(([, result]) => result === null)).toBe(true);
  expect(settledByDeadline).toBe(true);
});

it.each([false, true])("uses the body-resolved budget after a slow /responses upload, compact=%s", async compact => {
  let outbound = 0;
  const upstream = await startUpstream((_req, res) => {
    outbound++;
    writeJsonResponse(res, { status: "completed", output: [] });
  });
  const app = await startApp(upstream.url, upstream.url, { timeouts: { primary_ms: 100, compact_ms: 1000 } });
  const body = JSON.stringify({ model: "synthetic", input: "hello", ...(compact ? {
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) }
  } : {}) });
  let send!: http.ClientRequest;
  const pending = new Promise<number>((resolve, reject) => {
    send = http.request(`${app.url}/v1/responses`, { method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body)
    } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    send.once("error", reject);
    send.write(body.slice(0, 1));
  });
  await delay(250);
  send.end(body.slice(1));
  expect(await pending).toBe(compact ? 200 : 502);
  expect(outbound).toBe(compact ? 1 : 0);
});

it.each(["timeout", "disconnect"])("keeps a shared OAuth refresh usable after one wait exits via %s", async reason => {
  const issuer = oauthTestProvider("openai-codex");
  const app = await startApp(undefined, undefined, {}, issuer);
  const accountId = await issuer.authorize(app.config.oauth);
  await app.config.saveOAuthProfile("codex", accountId, "Synthetic", "fixture", app.config.revision);
  await app.config.applyProfile("codex", app.config.toPublicConfig().profiles[0].id);
  const route = app.config.get().primary;
  issuer.advance(3_550_000);
  const fetchToken = issuer.fetcher.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  issuer.fetcher.mockImplementationOnce(async (...args) => { await gate; return fetchToken(...args); });
  const calls = issuer.fetcher.mock.calls.length;
  const request = () => ({ upstream: new URL(`${route.base_url}/responses`), requestHeaders: {} as Record<string, string>, upstreamBody: Buffer.from('{"model":"fixture","input":"synthetic"}') });
  const first = request();
  const second = request();
  const res = new EventEmitter() as ServerResponse;
  const budget = { startedAt: performance.now(), timeoutMs: 1000, timeoutMessage: "Synthetic preparation timed out." };
  const cancelled = prepareOAuthRequest(route, app.config.oauth, first, "POST", { ...budget, timeoutMs: reason === "timeout" ? 50 : 1000, res }).catch(error => error);
  const surviving = prepareOAuthRequest(route, app.config.oauth, second, "POST", budget);
  if (reason === "disconnect") res.emit("close");
  const error = await cancelled;
  expect(error.details.kind).toBe(reason === "timeout" ? "timeout" : "client_cancel");
  expect(res.listenerCount("close")).toBe(0);
  release();
  expect(await surviving).toBe("openai-codex");
  expect(issuer.fetcher.mock.calls.length - calls).toBe(1);
  expect(first.requestHeaders.authorization).toBeUndefined();
  expect(second.requestHeaders.authorization).toMatch(/^Bearer synthetic\./);
});
