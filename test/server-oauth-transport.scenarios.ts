import http, { type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "../src/shared/oauth.js";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import {
  captureRequest, fetchJson, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse,
  type CapturedRequest
} from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

const responseItem = { id: "msg_oauth", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "oauth response" }] };
const sse = (res: ServerResponse, events: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
};

async function fixture(provider: OAuthProviderId, respond?: (req: CapturedRequest, res: ServerResponse) => void) {
  const issuer = oauthTestProvider(provider);
  const requests: CapturedRequest[] = [];
  const destinations: URL[] = [];
  const upstream = await startUpstream(async (req, res) => {
    const request = await captureRequest(req);
    requests.push(request);
    if (respond) return respond(request, res);
    if (req.method === "GET") {
      writeJsonResponse(res, provider === "openai-codex" ? { models: [{ slug: "test-model", visibility: "list" }, { slug: "hidden-model", visibility: "hide" }] }
        : { data: [{ id: "test-model", policy: { state: "enabled" }, supported_endpoints: ["/chat/completions"] },
          ...(provider === "github-copilot" ? [{ id: "disabled-model", policy: { state: "disabled" } }] : [])] });
      return;
    }
    if (provider === "openai-codex") {
      if (req.url?.endsWith("/responses/compact")) {
        writeJsonResponse(res, { id: "resp_compact", output: [{ type: "compaction", encrypted_content: "synthetic-compaction" }] });
      } else {
        sse(res, [
          { type: "response.created", response: { id: "resp_oauth", model: "test-model", status: "in_progress" } },
          { type: "response.output_item.added", output_index: 0, item: { ...responseItem, content: [] } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "oauth response" },
          { type: "response.output_item.done", output_index: 0, item: responseItem },
          { type: "response.done", response: { id: "resp_oauth", model: "test-model", status: "completed", output: [responseItem], usage: { input_tokens: 12, output_tokens: 3 } } }
        ]);
      }
      return;
    }
    if (provider === "kimi-code") {
      writeJsonResponse(res, { id: "msg_kimi", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text: "oauth response" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 3 } });
      return;
    }
    writeJsonResponse(res, { id: "chat_oauth", object: "chat.completion", model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "oauth response" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
  });
  // Mock the external TLS transport only. Application routing, serialization,
  // server I/O, streaming, model parsing and persistent stores are exercised.
  vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    if (!(target instanceof URL)) throw new Error("Unexpected HTTPS request signature in OAuth fixture.");
    destinations.push(new URL(target));
    return http.request(new URL(target.pathname + target.search, upstream.url), {
      ...options, agent: undefined, headers: { ...options.headers, host: target.host }
    }, callback);
  }) as typeof https.request);
  const app = await startApp(undefined, undefined, { primary_failover: { auto_schedule: false } }, issuer);
  const accountId = await issuer.authorize(app.config.oauth);
  const useScope = async (scope: "codex" | "claude") => {
    await app.config.saveOAuthProfile(scope, accountId, `OAuth ${scope}`, "test-model", app.config.revision);
    await app.config.applyProfile(scope, app.config.toPublicConfig().profile_scopes[scope].profiles[0].id);
  };
  return { ...app, issuer, requests, destinations, accountId, useScope };
}

describe("OAuth model transport integration", () => {
  it.each(OAUTH_PROVIDERS.map((p) => p.id))("runs %s through both Codex and Claude ingress", async (provider) => {
    const f = await fixture(provider);
    for (const scope of ["codex", "claude"] as const) {
      await f.useScope(scope);
      const path = scope === "codex" ? "/v1/responses" : "/anthropic/v1/messages";
      const body = scope === "codex" ? { model: "client-model", input: "hello", stream: false }
        : { model: "client-model", max_tokens: 30, stream: false, messages: [{ role: "user", content: "hello" }] };
      const response = await postJson(f.url, path, body, { authorization: "Bearer synthetic-client", "x-api-key": "synthetic-client-key", cookie: "synthetic-client-cookie" });
      const responseText = await response.text();
      expect(response.status, responseText).toBe(200);
      expect(responseText).toContain("oauth response");
      expect(responseText).not.toContain("synthetic-");
      expect(response.headers.get("content-type")).toContain("application/json");
      const request = f.requests.at(-1)!;
      expect(request.headers.authorization).toBe(`Bearer ${(await f.config.oauth.credentials(f.accountId)).access_token}`);
      expect(request.headers["x-api-key"]).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.originator).toBe(provider === "openai-codex" ? "codex-tui" : undefined);
      const expectedPath = provider === "openai-codex" ? "/backend-api/codex/responses" : provider === "kimi-code" ? "/coding/v1/messages"
        : provider === "github-copilot" ? "/chat/completions" : new URL(f.config.oauth.get(f.accountId)!.base_url).pathname + "/chat/completions";
      expect(request.url).toBe(expectedPath);
      expect(f.destinations.at(-1)!.origin).toBe(new URL(f.config.oauth.get(f.accountId)!.base_url).origin);
    }
  });

  it("streams Codex terminal events and Claude conversion without a buffered-only shortcut", async () => {
    const f = await fixture("openai-codex");
    await f.useScope("codex");
    const codex = await postJson(f.url, "/v1/responses", { model: "test-model", input: "hello", stream: true });
    expect(codex.headers.get("content-type")).toContain("text/event-stream");
    expect(await codex.text()).toContain("response.completed");
    await f.useScope("claude");
    const claude = await postJson(f.url, "/anthropic/v1/messages", { model: "test-model", max_tokens: 30, stream: true, messages: [{ role: "user", content: "hello" }] });
    const text = await claude.text();
    expect(text).toContain("oauth response");
    expect(text).toContain("message_stop");
  });

  it.each(OAUTH_PROVIDERS.filter((p) => p.id !== "openai-codex").map((p) => p.id))("streams %s through both client protocols", async (provider) => {
    const f = await fixture(provider, (_request, res) => sse(res, provider === "kimi-code" ? [
      { type: "message_start", message: { id: "msg_stream", model: "test-model", usage: { input_tokens: 12 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "oauth stream" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" }
    ] : [
      { id: "chat_stream", model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "oauth stream" }, finish_reason: null }] },
      { id: "chat_stream", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }
    ]));
    for (const scope of ["codex", "claude"] as const) {
      await f.useScope(scope);
      const response = await postJson(f.url, scope === "codex" ? "/v1/responses" : "/anthropic/v1/messages", scope === "codex"
        ? { model: "test-model", input: "hello", stream: true }
        : { model: "test-model", max_tokens: 30, messages: [{ role: "user", content: "hello" }], stream: true });
      const text = await response.text();
      expect(text).toContain("oauth stream");
      expect(text).toContain(scope === "codex" ? "response.completed" : "message_stop");
      const log = await waitForLogEntry(f.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
      expect(log.error_summary).toBeNull();
      expect(log.stream_outcome).toBe("success");
    }
  });

  it("settles a translated Codex terminal when the client closes before upstream HTTP end", async () => {
    const f = await fixture("openai-codex", (_request, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.done", response: { id: "resp_closed", status: "completed", output: [responseItem] } })}\n\n`);
    });
    await f.useScope("codex");
    const response = await postJson(f.url, "/v1/responses", { model: "test-model", input: "hello", stream: true });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.completed");
    await reader.cancel();
    const log = await waitForLogEntry(f.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log).toMatchObject({ status: 200, stream_outcome: "success", stream_terminal_event: "response.completed", error_summary: null });
  });

  it.each(OAUTH_PROVIDERS.map((p) => p.id))("discovers %s models using its actual catalog shape", async (provider) => {
    const f = await fixture(provider);
    const { response, body } = await fetchJson<{ models: string[]; error: string | null }>(`${f.url}/api/oauth/accounts/${f.accountId}/models`, "GET");
    expect(response.status).toBe(200);
    if (provider === "google-vertex") {
      expect(body.models).toEqual([]);
      expect(body.error).toContain("填写 ID");
      expect(f.requests).toHaveLength(0);
    } else {
      expect(body).toMatchObject({ models: ["test-model"], error: null });
      expect(f.requests[0].headers.authorization).toBeTruthy();
      expect(f.requests[0].headers.originator).toBe(provider === "openai-codex" ? "codex-tui" : undefined);
      if (provider === "openai-codex") expect(f.requests[0].url).toMatch(/\/models\?client_version=/);
    }
  });

  it("refreshes once before concurrent requests and stops sending after disconnect", async () => {
    const f = await fixture("qwen-code");
    await f.useScope("codex");
    f.issuer.advance(3_550_000);
    const tokenCalls = f.issuer.fetcher.mock.calls.length;
    const results = await Promise.all([1, 2, 3].map(() => postJson(f.url, "/v1/responses", { model: "test-model", input: "hello" })));
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(f.issuer.fetcher).toHaveBeenCalledTimes(tokenCalls + 1);
    expect(new Set(f.requests.map((req) => req.headers.authorization)).size).toBe(1);
    await f.config.oauth.disconnect(f.accountId);
    const denied = await postJson(f.url, "/v1/responses", { model: "test-model", input: "hello" }, { authorization: "Bearer synthetic-fallback" });
    expect(denied.status).toBe(401);
    expect(f.requests).toHaveLength(3);
    expect(await denied.text()).toContain("Reconnect");
  });

  it("uses OAuth for compact and capability probing, and rejects unsupported token-count routes", async () => {
    const f = await fixture("openai-codex");
    await f.useScope("codex");
    const compact = await postJson(f.url, "/v1/responses/compact", { model: "test-model", input: "hello", stream: false });
    expect(compact.status).toBe(200);
    expect(await compact.text()).toContain("compaction");
    const probe = await fetchJson<{ supported: boolean }>(`${f.url}/api/compact/capability-probe`, "POST", { model: "test-model" });
    expect(probe.body.supported).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every((req) => JSON.parse(req.body).stream === undefined && req.headers["chatgpt-account-id"] === "synthetic-account")).toBe(true);
    expect(f.requests.map((req) => req.headers.originator)).toEqual(["codex-tui", "codex-tui"]);
    await f.useScope("claude");
    const count = await postJson(f.url, "/anthropic/v1/messages/count_tokens", { model: "test-model", messages: [{ role: "user", content: "hello" }] });
    expect(count.status).toBe(400);
    expect(f.requests).toHaveLength(2);
  });

  it("records a failed Codex stream as a failure rather than healthy usage", async () => {
    const f = await fixture("openai-codex", (_req, res) => sse(res, [
      { type: "response.failed", response: { id: "resp_denied", status: "failed", error: { message: "Synthetic refusal" } } }
    ]));
    await f.useScope("codex");
    const response = await postJson(f.url, "/v1/responses", { model: "test-model", input: "hello", stream: true });
    expect(await response.text()).toContain("response.failed");
    const requestId = response.headers.get("x-compactgate-request-id")!;
    const log = await waitForLogEntry(f.url, (entry) => entry.request_id === requestId);
    expect(log.error_summary).toBeTruthy();
    expect(log.stream_outcome).not.toBe("success");
  });
});
