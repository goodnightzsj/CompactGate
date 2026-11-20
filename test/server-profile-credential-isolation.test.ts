import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import {
  captureBody, postJson, setEnv, startApp, startUpstream, waitForLogEntry, writeJsonResponse
} from "./helpers/server-test-utils.js";

it.each(["direct", "env"] as const)("keeps a pool-free %s profile's credential isolated during failover", async (kind) => {
  const used: Array<{ upstream: string; authorization: string | undefined }> = [];
  const a = await startUpstream(async (req, res) => {
    await captureBody(req);
    used.push({ upstream: "A", authorization: req.headers.authorization });
    writeJsonResponse(res, { error: { message: "invalid api key" } }, 401);
  });
  const b = await startUpstream(async (req, res) => {
    await captureBody(req);
    used.push({ upstream: "B", authorization: req.headers.authorization });
    writeJsonResponse(res, { id: "resp_synthetic", status: "completed", output: [] });
  });
  const envName = "COMPACTGATE_TEST_PROFILE_B_KEY";
  setEnv(envName, "synthetic-B-env");
  const primary = {
    ...DEFAULT_CONFIG.primary, base_url: a.url, api_key: "", api_key_env: "",
    api_keys: [{ id: "a-key", label: "A", api_key: "synthetic-A-only", enabled: true, priority: 1 }]
  };
  const backup = {
    ...DEFAULT_CONFIG.primary, base_url: b.url,
    api_key: kind === "direct" ? "synthetic-B-direct" : "",
    api_key_env: kind === "env" ? envName : "", api_keys: []
  };
  const app = await startApp();
  await app.config.importConfig({
    ...DEFAULT_CONFIG, primary,
    profile_scopes: { codex: { active_profile_id: "a", profiles: [
      { id: "a", name: "A", config: { primary } },
      { id: "b", name: "B", config: { primary: backup } }
    ] } }
  });
  const saved = app.config.get().profile_scopes!.codex!.profiles![1].config;
  expect(saved).toHaveProperty("primary");
  if (!("primary" in saved)) throw new Error("Expected Codex profile.");
  expect(saved.primary).not.toHaveProperty("api_keys");

  for (const status of [401, 200]) {
    const response = await postJson(app.url, "/v1/responses", { model: "fixture", input: "hi" });
    expect(response.status).toBe(status);
    await response.text();
    await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
  }
  expect(used).toEqual([
    { upstream: "A", authorization: "Bearer synthetic-A-only" },
    { upstream: "B", authorization: `Bearer synthetic-B-${kind}` }
  ]);
});
