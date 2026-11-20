import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

it.each([
  { generation: "/v1/responses", catalog: "/models", body: { model: "demo", input: "hi" } },
  { generation: "/anthropic/v1/messages", catalog: "/anthropic/v1/models", body: {
    model: "demo", max_tokens: 20, messages: [{ role: "user", content: "hi" }]
  } }
])("keeps catalog permissions separate from generation health on $generation", async ({ generation, catalog, body }) => {
  const usedKeys: string[] = [];
  let denyGeneration = false;
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    const first = req.headers.authorization === "Bearer synthetic-first";
    usedKeys.push(first ? "first" : "second");
    if (req.method === "GET" || (first && denyGeneration)) return writeJsonResponse(res, { error: "permission denied" }, 403);
    writeJsonResponse(res, generation.endsWith("/messages")
      ? { id: "msg_demo", type: "message", role: "assistant", model: "demo", content: [], stop_reason: "end_turn" }
      : { id: "resp_demo", status: "completed", output: [] });
  });
  const pool = { base_url: upstream.url, api_key: "", api_key_env: "", api_keys: [
    { id: "k1", label: "first", api_key: "synthetic-first", enabled: true, priority: 2 },
    { id: "k2", label: "second", api_key: "synthetic-second", enabled: true, priority: 1 }
  ] };
  const primary = { ...DEFAULT_CONFIG.primary, ...pool };
  const claude = { ...DEFAULT_CONFIG.claude, primary: { ...DEFAULT_CONFIG.claude.primary, ...pool } };
  const app = await startApp(upstream.url, undefined, { primary, claude, profile_scopes: {
    codex: { active_profile_id: "p", profiles: [{ id: "p", name: "P", config: { primary } }] },
    claude: { active_profile_id: "c", profiles: [{ id: "c", name: "C", config: { claude } }] }
  } });
  const headers = { "x-session-id": "synthetic-session" };
  async function generate(expected: number) {
    const response = await postJson(app.url, generation, body, headers);
    expect(response.status).toBe(expected);
    await response.text();
    await waitForLogEntry(app.url, log => log.request_id === response.headers.get("x-compactgate-request-id"));
  }
  await generate(200);
  const listed = await fetch(app.url + catalog, { headers });
  expect(listed.status).toBe(403);
  await listed.text();
  expect(await waitForLogEntry(app.url, log => log.request_id === listed.headers.get("x-compactgate-request-id")))
    .toMatchObject({ status: 403, key_name: "first" });
  await generate(200);
  denyGeneration = true;
  await generate(403);
  await generate(200);
  expect(usedKeys).toEqual(["first", "first", "first", "first", "second"]);
});
