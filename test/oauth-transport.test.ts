import path from "node:path";
import { Readable, type Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "../src/shared/oauth.js";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import { OAuthStore } from "../src/server/oauth-store.js";
import { prepareOAuthRequest } from "../src/server/oauth-transport.js";
import { createCodexResponseTransform } from "../src/server/oauth-response.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";

const stores: OAuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

async function connected(provider: OAuthProviderId) {
  const issuer = oauthTestProvider(provider);
  const store = await OAuthStore.load(path.join(await makeConfigDir(), "compactgate.json"), issuer);
  stores.push(store);
  const id = await issuer.authorize(store);
  const account = store.get(id)!;
  const route = { ...DEFAULT_CONFIG.primary, base_url: account.base_url, upstream_protocol: account.upstream_protocol, oauth_account_id: id };
  return { issuer, store, id, account, route };
}

describe("OAuth request boundary", () => {
  it.each(OAUTH_PROVIDERS.map((provider) => provider.id))("applies %s authorization at its bound destination only", async (provider) => {
    const f = await connected(provider);
    const endpoint = provider === "openai-codex" ? "/responses" : provider === "kimi-code" ? "/v1/messages" : "/chat/completions";
    const request = {
      upstream: new URL(f.account.base_url + endpoint), upstreamBody: Buffer.from('{"input":"hello"}'),
      requestHeaders: { authorization: "Bearer incoming", cookie: "incoming-cookie", "api-key": "incoming-key", "x-api-key": "incoming-key", "openai-project": "wrong-account" } as Record<string, string>
    };
    expect(await prepareOAuthRequest(f.route, f.store, request)).toBe(provider);
    expect(request.requestHeaders.authorization).toBe(`Bearer ${(await f.store.credentials(f.id)).access_token}`);
    for (const field of ["cookie", "api-key", "x-api-key", "openai-project"]) expect(request.requestHeaders[field]).toBeUndefined();
    expect(request.requestHeaders["accept-encoding"]).toBe("identity");
  });

  it("rejects destination, protocol, method and endpoint changes without transmitting credentials", async () => {
    const f = await connected("openrouter");
    for (const url of ["https://evil.example/chat/completions", "https://openrouter.ai/api/v10/chat/completions", "https://openrouter.ai/api/v1/billing", "https://user@openrouter.ai/api/v1/chat/completions"]) {
      await expect(prepareOAuthRequest(f.route, f.store, { upstream: new URL(url), requestHeaders: {}, upstreamBody: Buffer.alloc(0) })).rejects.toThrow(/endpoint/);
    }
    await expect(prepareOAuthRequest({ ...f.route, upstream_protocol: "openai_responses" }, f.store, {
      upstream: new URL(f.account.base_url + "/chat/completions"), requestHeaders: {}, upstreamBody: Buffer.alloc(0)
    })).rejects.toThrow(/protocol/);
    await f.store.disconnect(f.id);
    const request = { upstream: new URL(f.account.base_url + "/chat/completions"), requestHeaders: { authorization: "incoming" }, upstreamBody: Buffer.alloc(0) };
    await expect(prepareOAuthRequest(f.route, f.store, request)).rejects.toMatchObject({ status: 401 });
    await expect(prepareOAuthRequest(f.route, undefined, request)).rejects.toMatchObject({ status: 503 });
  });

  it("leaves the manual credential path unchanged", async () => {
    const request = { upstream: new URL("http://localhost/v1/responses"), requestHeaders: { authorization: "manual" }, upstreamBody: Buffer.from("original") };
    const original = { ...request };
    expect(await prepareOAuthRequest(DEFAULT_CONFIG.primary, undefined, request)).toBeNull();
    expect(request).toEqual(original);
  });

  it("adapts Codex transport fields while preserving provider-owned history and tool choices", async () => {
    const f = await connected("openai-codex");
    const body = { stream: false, store: true, max_output_tokens: 100, temperature: 0.5, parallel_tool_calls: false,
      input: [{ role: "system", content: "system" }, { type: "reasoning", encrypted_content: "synthetic-state" }] };
    const request = { upstream: new URL(f.account.base_url + "/responses"), requestHeaders: { "content-encoding": "gzip" } as Record<string, string>, upstreamBody: Buffer.from(JSON.stringify(body)) };
    await prepareOAuthRequest(f.route, f.store, request);
    expect(JSON.parse(request.upstreamBody.toString())).toMatchObject({ stream: true, store: false, instructions: "", parallel_tool_calls: false,
      input: [{ role: "developer" }, { encrypted_content: "synthetic-state" }] });
    expect(JSON.parse(request.upstreamBody.toString()).max_output_tokens).toBeUndefined();
    expect(request.requestHeaders["content-encoding"]).toBeUndefined();
    expect(request.requestHeaders["chatgpt-account-id"]).toBe("synthetic-account");
    request.upstream = new URL(f.account.base_url + "/responses/compact");
    await prepareOAuthRequest(f.route, f.store, request);
    expect(JSON.parse(request.upstreamBody.toString()).stream).toBeUndefined();
  });

  it("keeps Copilot initiation and image headers truthful", async () => {
    const f = await connected("github-copilot");
    const request = { upstream: new URL(f.account.base_url + "/chat/completions"), requestHeaders: {} as Record<string, string>, upstreamBody: Buffer.from(JSON.stringify({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,test" } }] }, { role: "tool", content: "result" }]
    })) };
    await prepareOAuthRequest(f.route, f.store, request);
    expect(request.requestHeaders).toMatchObject({ "x-initiator": "agent", "copilot-vision-request": "true", "copilot-integration-id": "vscode-chat" });
    request.upstreamBody = Buffer.from('{"messages":[{"role":"user","content":"hello"}]}');
    await prepareOAuthRequest(f.route, f.store, request);
    expect(request.requestHeaders["x-initiator"]).toBe("user");
    expect(request.requestHeaders["copilot-vision-request"]).toBeUndefined();
  });
});

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
async function transformed(stream: Duplex, body: string) {
  const bytes = Buffer.from(body);
  Readable.from([bytes.subarray(0, 13), bytes.subarray(13, 29), bytes.subarray(29)]).pipe(stream);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe("Codex response adaptation", () => {
  const headers = { "content-type": "text/event-stream", "content-length": "500", "transfer-encoding": "chunked" };
  const item = { id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] };
  const done = (type = "response.done") => ({ type, response: { id: "resp_test", model: "test-model", status: "completed", usage: { input_tokens: 8, output_tokens: 2 } } });

  it.each([false, true])("preserves completed output and usage with client stream=%s", async (stream) => {
    const result = createCodexResponseTransform(200, headers, stream)!;
    const output = await transformed(result.stream, frame({ type: "response.output_item.done", output_index: 0, item }) + frame(done()));
    expect(output).toContain("你好");
    expect(output).toContain("input_tokens");
    expect(output).not.toContain("response.done");
    if (stream) expect(output).toContain("response.completed");
    else expect(JSON.parse(output).output).toEqual([item]);
    expect(result.responseHeaders["content-length"]).toBeUndefined();
    expect(result.translationError).toBeUndefined();
  });

  it.each([false, true])("composes Claude conversion with client stream=%s", async (stream) => {
    const result = createCodexResponseTransform(200, headers, stream, true)!;
    const output = await transformed(result.stream, frame({ type: "response.output_item.done", output_index: 0, item }) + frame(done()));
    if (stream) expect(output).toContain("message_stop");
    else expect(JSON.parse(output)).toMatchObject({ type: "message", content: [{ type: "text", text: "你好" }] });
    expect(result.streamProtocol).toBe("anthropic");
  });

  it("does not turn missing terminal, failed or incomplete responses into success", async () => {
    for (const body of [frame({ type: "response.created", response: {} }), frame({ type: "response.done", response: { status: "failed", error: { message: "No access" } } }), frame({ type: "response.incomplete", response: { status: "incomplete" } })]) {
      const result = createCodexResponseTransform(200, headers, false)!;
      const output = JSON.parse(await transformed(result.stream, body));
      expect(["failed", "incomplete"]).toContain(output.status);
      expect(result.translationError).toBeTruthy();
    }
  });

  it("rejects malformed events and leaves HTTP errors to the existing error path", async () => {
    const result = createCodexResponseTransform(200, headers, false)!;
    await expect(transformed(result.stream, "data: not-json\n\n")).rejects.toThrow(/invalid SSE/);
    expect(createCodexResponseTransform(401, headers, true)).toBeNull();
    expect(createCodexResponseTransform(200, { "content-type": "application/json" }, false)).toBeNull();
  });
});
