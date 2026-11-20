import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

it.each(["primary", "compact-linked", "compact-custom"])("queries and clears health for actual candidate models: %s", mode => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.primary_failover.auto_schedule = false;
  config.compact = { ...config.compact, upstream_mode: "primary",
    model_mode: mode === "compact-custom" ? "custom" : "linked", model_override: "vendor-compact", model_template: "{model}-compact" };
  config.profile_scopes = { codex: { active_profile_id: "a", profiles: ["a", "b"].map(id => ({
    id, name: id, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z",
    config: { primary: { ...config.primary, model_override: `vendor-${id}` }, compact: config.compact }
  })) } };
  const state = new PrimaryFailoverState({ now: () => 0, random: () => 0 });
  const modelRoute = mode === "primary" ? "primary" : "compact";
  for (let i = 0; i < 11; i++) {
    const selected = state.preview(config, { model: "client-alias-a", modelRoute });
    state.reserveSelection(selected, false);
    state.recordResult(selected, 404, "model not found");
  }
  config.primary_failover.auto_schedule = true;
  expect(state.preview(config, { model: "client-alias-b", modelRoute }).profileId).toBe("b");
  config.primary_failover.auto_schedule = false;
  const success = state.preview(config, { model: "client-alias-b", modelRoute });
  expect(success.profileId).toBe("a");
  expect(success.context.model).toBe("client-alias-b");
  state.reserveSelection(success, false);
  state.recordResult(success, 200);
  config.primary_failover.auto_schedule = true;
  expect(state.preview(config, { model: "client-alias-c", modelRoute }).profileId).toBe("a");
});

it.each([false, true])("does not apply compact model incompatibility to ordinary generation, compact-fails=%s", async compactFails => {
  const requests: Array<{ path: string; key: string; model: string }> = [];
  const upstream = await startUpstream(async (req, res) => {
    const body = JSON.parse((await captureBody(req)).toString());
    const compact = req.url?.endsWith("/responses/compact") === true;
    const key = String(req.headers.authorization);
    requests.push({ path: req.url ?? "", key, model: body.model });
    const failed = compact && compactFails;
    writeJsonResponse(res, failed ? { error: { message: "model synthetic-compact not found", type: "invalid_request_error", code: "model_not_found" } }
      : compact ? { id: "cmp_synthetic", output: [{ type: "compaction", encrypted_content: "synthetic-state" }] }
        : { id: `resp_synthetic_${requests.length}`, status: "completed", output: [] }, failed ? 404 : 200);
  });
  const primary = { ...DEFAULT_CONFIG.primary, base_url: upstream.url, api_key: "", api_key_env: "",
    api_keys: ["first", "second"].map(id => ({ id, label: id, api_key: `synthetic-${id}`, enabled: true })) };
  const compact = { ...DEFAULT_CONFIG.compact, upstream_mode: "primary", model_mode: "custom", model_override: "synthetic-compact" };
  const app = await startApp(upstream.url, undefined, { primary, compact, primary_failover: { auto_schedule: true },
    profile_scopes: { codex: { active_profile_id: "pool", profiles: [{ id: "pool", name: "Pool", config: { primary, compact } }] } } });
  for (let index = 0; index < 11; index++) {
    const response = await postJson(app.url, "/v1/responses/compact", { model: "synthetic-primary", input: `synthetic-${index}` });
    await response.text();
    expect(response.status).toBe(compactFails ? 404 : 200);
    await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
  }
  const generation = await postJson(app.url, "/v1/responses", { model: "synthetic-primary", input: "ordinary generation" });
  await generation.text();
  expect(generation.status).toBe(200);
  expect(requests.slice(0, 11).every(request => request.model === "synthetic-compact")).toBe(true);
  expect(requests.at(-1)).toEqual({ path: "/v1/responses", key: "Bearer synthetic-first", model: "synthetic-primary" });
});
