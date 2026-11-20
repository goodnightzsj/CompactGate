import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { ClaudeKeyPoolState } from "../src/server/claude-key-pool.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

function claudeConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.claude.primary.api_key_env = "";
  config.claude.primary.key_strategy = "spread";
  config.claude.primary.api_keys = [
    { id: "first", label: "First", api_key: "synthetic-first", enabled: true },
    { id: "second", label: "Second", api_key: "synthetic-second", enabled: true }
  ];
  return config;
}

it.each([false, true])("retains a healthy Claude profile pin after another scene profile is used=%s", otherProfile => {
  let roll = 0;
  const state = new ClaudeKeyPoolState({ now: () => 1_000, random: () => roll });
  const config = claudeConfig();
  const headers = { "x-claude-code-session-id": "synthetic-session" };
  const first = state.select(config, "profile-a", headers);
  expect(first?.keyId).toBe("first");
  state.recordResult(first, { status: 200, responseHeaders: {} });
  roll = 0.99;
  if (otherProfile) {
    const background = state.select(config, "profile-b", headers);
    expect(background?.keyId).toBe("second");
    state.recordResult(background, { status: 200, responseHeaders: {} });
  }
  expect(state.select(config, "profile-a", headers)?.keyId).toBe("first");
});

it.each([false, true])("preserves a Claude session's default-profile key with background HTTP scene=%s", async otherScene => {
  const keys: string[] = [];
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    keys.push(String(req.headers.authorization));
    writeJsonResponse(res, { id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const config = claudeConfig();
  config.claude.primary.base_url = upstream.url;
  config.claude.scene_map.background.profile_id = "profile-b";
  const background = structuredClone(config.claude);
  background.primary.api_keys = [
    { id: "first", label: "B First", api_key: "synthetic-b-first", enabled: true },
    { id: "second", label: "B Second", api_key: "synthetic-b-second", enabled: true }
  ];
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const app = await startApp(undefined, undefined, {
    claude: config.claude,
    profile_scopes: { claude: { active_profile_id: "profile-a", profiles: [
      { id: "profile-a", name: "A", config: { claude: config.claude } },
      { id: "profile-b", name: "B", config: { claude: background } }
    ] } }
  });
  const models = otherScene ? ["claude-sonnet-synthetic", "claude-haiku-synthetic", "claude-sonnet-synthetic"]
    : ["claude-sonnet-synthetic", "claude-sonnet-synthetic"];
  for (const [index, model] of models.entries()) {
    if (index > 0) random.mockReturnValue(0.99);
    const response = await postJson(app.url, "/anthropic/v1/messages", {
      model, max_tokens: 10, messages: [{ role: "user", content: "synthetic" }]
    }, { "x-claude-code-session-id": "scene-session" });
    expect(response.status).toBe(200);
    await response.text();
    await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
  }
  expect(keys).toEqual(otherScene
    ? ["Bearer synthetic-first", "Bearer synthetic-b-second", "Bearer synthetic-first"]
    : ["Bearer synthetic-first", "Bearer synthetic-first"]);
});
