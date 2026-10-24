import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CapturedRequest, startApp, waitForLogEntry } from "./helpers/server-test-utils.js";
import { postClaudeMessage, startCapturedClaudeUpstream, writeJsonResponse } from "./server-claude-core-helpers.js";

afterEach(() => vi.restoreAllMocks());

const FORMAT = { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } };
const ADAPTIVE = { type: "adaptive", display: "omitted" };
const REQUEST = {
  model: "claude-opus-5-5", max_tokens: 32000,
  thinking: ADAPTIVE, output_config: { effort: "high", format: FORMAT },
  messages: [{ role: "user", content: "Synthetic thinking adaptation test" }]
};

function mappedModel(model: string) {
  return { default: model, opus: "", sonnet: "", haiku: "", reasoning: "", subagent: "" };
}

// Exercise the real proxy and HTTP body, replacing only the external HTTPS transport.
function redirectHttps(upstreamUrl: string) {
  return vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    return http.request(new URL(target.pathname + target.search, upstreamUrl), { ...options, agent: undefined }, callback);
  }) as typeof https.request);
}

describe("Claude thinking adaptation at the final upstream boundary", () => {
  it.each([
    ["https://api.anthropic.com", "claude-sonnet-4-5", { type: "enabled", display: "omitted", budget_tokens: 20000 }, { format: FORMAT }],
    ["https://api.anthropic.com", "claude-opus-4-5", { type: "enabled", display: "omitted", budget_tokens: 20000 }, REQUEST.output_config],
    ["https://api.anthropic.com", "claude-opus-4-6", ADAPTIVE, REQUEST.output_config],
    ["https://api.anthropic.com", "claude-opus-5-5", ADAPTIVE, REQUEST.output_config],
    ["https://relay.example", "claude-sonnet-4-5", ADAPTIVE, REQUEST.output_config],
    ["https://relay.example", "global:deepseek-v4.1-flash-sg", ADAPTIVE, REQUEST.output_config]
  ])("uses the scene-selected endpoint %s and model %s", async (baseUrl, model, thinking, outputConfig) => {
    const captures: CapturedRequest[] = [];
    const local = await startCapturedClaudeUpstream(captures, (_req, res) => {
      writeJsonResponse(res, { id: "msg_test", type: "message", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
    });
    const transport = redirectHttps(local.url);
    const app = await startApp(undefined, undefined, { claude: {
      primary: { base_url: baseUrl === "https://api.anthropic.com" ? "https://relay.example" : "https://api.anthropic.com", api_key: "synthetic-key", api_key_env: "" }
    } });
    await app.config.saveProfile("claude", "Thinking scene", { claude: {
      primary: { base_url: baseUrl }, model_map: mappedModel(model)
    } });
    const id = app.config.toPublicConfig().profile_scopes.claude.profiles[0].id;
    await app.config.patch({ claude: { scene_map: { thinking: { profile_id: id } } } });
    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages?beta=true", REQUEST);
    expect(response.status, await response.text()).toBe(200);
    expect(response.headers.get("x-compactgate-profile-source")).toBe("scene");
    expect(captures).toHaveLength(1);
    expect(transport.mock.calls[0]?.[0]).toEqual(new URL(`${baseUrl}/v1/messages?beta=true`));
    expect(JSON.parse(captures[0].body)).toEqual({ ...REQUEST, model, thinking, output_config: outputConfig });
    const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log).toMatchObject({ target_model: model, upstream_host: new URL(baseUrl).host, status: 200 });
  });

  it("honors an explicit relay profile over an official scene profile without consuming max effort", async () => {
    const captures: CapturedRequest[] = [];
    const local = await startCapturedClaudeUpstream(captures, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_sse","type":"message","role":"assistant","model":"synthetic","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ].join(""));
    });
    const transport = redirectHttps(local.url);
    const app = await startApp(undefined, undefined, { claude: {
      primary: { base_url: "https://api.anthropic.com", api_key: "synthetic-key", api_key_env: "" },
      model_map: mappedModel("claude-sonnet-4-5")
    } });
    await app.config.saveProfile("claude", "Official", { claude: { primary: { base_url: "https://api.anthropic.com" } } });
    await app.config.saveProfile("claude", "Relay", { claude: {
      primary: { base_url: "https://opencode.9962510.xyz" }, model_map: mappedModel("global:deepseek-v4.1-flash-sg")
    } });
    const profiles = app.config.toPublicConfig().profile_scopes.claude.profiles;
    const official = profiles.find(profile => profile.name === "Official")!;
    const relay = profiles.find(profile => profile.name === "Relay")!;
    await app.config.patch({ claude: { scene_map: { thinking: { profile_id: official.id } } } });
    const request = { ...REQUEST, max_tokens: 128000, stream: true, output_config: { effort: "max" } };
    const response = await postClaudeMessage(app.url, "/anthropic/messages", request, {
      "content-type": "application/json", "x-compactgate-profile": relay.id
    });
    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(200);
    expect(responseBody).toContain("OK");
    expect(responseBody).toContain("message_stop");
    expect(response.headers.get("x-compactgate-profile-source")).toBe("explicit");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(captures).toHaveLength(1);
    expect(JSON.parse(captures[0].body)).toEqual({ ...request, model: "global:deepseek-v4.1-flash-sg" });
  });

  it("converts a manual request to adaptive after resolving a scene's model override", async () => {
    const captures: CapturedRequest[] = [];
    const local = await startCapturedClaudeUpstream(captures, (_req, res) => writeJsonResponse(res, { type: "message", content: [] }));
    redirectHttps(local.url);
    const app = await startApp(undefined, undefined, { claude: {
      primary: { base_url: "https://api.anthropic.com/v1", api_key: "synthetic-key", api_key_env: "" },
      model_map: mappedModel("claude-sonnet-4-5"), scene_map: { thinking: { model: "claude-opus-5" } }
    } });
    const request = { ...REQUEST, model: "claude-opus-4-5", thinking: { type: "enabled", budget_tokens: 31999 }, output_config: { effort: "low", format: FORMAT } };
    const response = await postClaudeMessage(app.url, "/anthropic/messages", request);
    expect(response.status, await response.text()).toBe(200);
    expect(captures).toHaveLength(1);
    expect(captures[0].url).toBe("/v1/messages");
    expect(JSON.parse(captures[0].body)).toEqual({ ...request, model: "claude-opus-5", thinking: { type: "adaptive" } });
  });

  it.each(["/anthropic/v1/messages/count_tokens", "/anthropic/messages/count_tokens"])(
    "does not adapt thinking on %s", async path => {
      const captures: CapturedRequest[] = [];
      const local = await startCapturedClaudeUpstream(captures, (_req, res) => writeJsonResponse(res, { input_tokens: 7 }));
      redirectHttps(local.url);
      const app = await startApp(undefined, undefined, { claude: {
        primary: { base_url: "https://api.anthropic.com", api_key: "synthetic-key", api_key_env: "" },
        model_map: mappedModel("claude-sonnet-4-5")
      } });
      const { max_tokens: _maxTokens, ...request } = REQUEST;
      const response = await postClaudeMessage(app.url, path, request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ input_tokens: 7 });
      expect(captures).toHaveLength(1);
      expect(JSON.parse(captures[0].body)).toEqual({ ...request, model: "claude-sonnet-4-5" });
    }
  );

  it.each([512, undefined])("returns 422 without an upstream attempt for max_tokens=%s", async maxTokens => {
    const captures: CapturedRequest[] = [];
    const local = await startCapturedClaudeUpstream(captures, (_req, res) => writeJsonResponse(res, { type: "message", content: [] }));
    const transport = redirectHttps(local.url);
    const app = await startApp(undefined, undefined, { claude: {
      primary: { base_url: "https://relay.example", api_key: "synthetic-key", api_key_env: "" }
    } });
    await app.config.saveProfile("claude", "Official", { claude: {
      primary: { base_url: "https://api.anthropic.com" }, model_map: mappedModel("claude-sonnet-4-5")
    } });
    const id = app.config.toPublicConfig().profile_scopes.claude.profiles[0].id;
    await app.config.patch({ claude: { scene_map: { thinking: { profile_id: id } } } });
    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", { ...REQUEST, max_tokens: maxTokens });
    expect(response.status).toBe(422);
    const failure = await response.json();
    expect(failure.error).toContain("max_tokens");
    expect(transport).not.toHaveBeenCalled();
    expect(captures).toHaveLength(0);
    const log = await waitForLogEntry(app.url, entry => entry.request_id === failure.request_id);
    expect(log).toMatchObject({ status: 422, upstream_status: null, upstream_host: "api.anthropic.com" });
  });

  it.each(["openai_responses", "openai_chat"])("leaves effort and format translation to %s", async protocol => {
    const captures: CapturedRequest[] = [];
    const local = await startCapturedClaudeUpstream(captures, (_req, res) => writeJsonResponse(res, protocol === "openai_responses"
      ? { id: "resp_test", model: "synthetic", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] }
      : { id: "chat_test", model: "synthetic", choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
    redirectHttps(local.url);
    const app = await startApp(undefined, undefined, { claude: {
      primary: { base_url: "https://api.anthropic.com", api_key: "synthetic-key", api_key_env: "", upstream_protocol: protocol },
      model_map: mappedModel("claude-sonnet-4-5")
    } });
    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", { ...REQUEST, output_config: { effort: "max", format: FORMAT } });
    expect(response.status, await response.text()).toBe(200);
    expect(captures).toHaveLength(1);
    const outgoing = JSON.parse(captures[0].body);
    expect(outgoing).not.toHaveProperty("thinking");
    expect(outgoing).not.toHaveProperty("output_config");
    if (protocol === "openai_responses") {
      expect(outgoing.reasoning.effort).toBe("xhigh");
      expect(outgoing.text.format.schema).toEqual(FORMAT.schema);
    } else {
      expect(outgoing.reasoning_effort).toBe("xhigh");
      expect(outgoing.response_format.json_schema.schema).toEqual(FORMAT.schema);
    }
  });
});
