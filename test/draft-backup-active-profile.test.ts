import { expect, it } from "vitest";
import { applyDraftToConfigExport, formFromConfig } from "../src/ui/config/config-form-state.js";
import { captureBody, postJson, startApp, startUpstream, writeJsonResponse } from "./helpers/server-test-utils.js";

it.each(["codex", "claude"] as const)("restores the actual %s request target from a draft backup", async scope => {
  for (const autoSchedule of [true, false]) {
    const received: Array<{ upstream: string; model: unknown; key: unknown }> = [];
    const upstream = async (name: string) => startUpstream(async (req, res) => {
      const body = JSON.parse(await captureBody(req));
      received.push({ upstream: name, model: body.model, key: req.headers.authorization });
      writeJsonResponse(res, scope === "codex"
        ? { id: "resp_synthetic", object: "response", status: "completed", output: [] }
        : { id: "msg_synthetic", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    });
    const a = await upstream("A");
    const b = await upstream("B");
    const app = await startApp();
    const route = { base_url: a.url, model_override: "saved-model", api_key: "synthetic-A", api_key_env: "" };
    const patch = scope === "codex" ? { primary: route } : { claude: { primary: route } };
    await app.config.saveProfile(scope, "Active", patch);
    await app.config.saveProfile(scope, "Inactive", patch);
    const id = app.config.toPublicConfig().profile_scopes[scope].profiles[0].id;
    await app.config.applyProfile(scope, id);
    const baseline = app.config.get();
    const form = formFromConfig(app.config.toPublicConfig());
    if (scope === "codex") {
      form.codexPrimaryBaseUrl = b.url;
      form.primaryModelOverride = "draft-model";
      form.codexPrimaryApiKey = "synthetic-B";
    } else {
      form.claudePrimaryBaseUrl = b.url;
      form.claudeModelMap.default = "draft-model";
      form.claudePrimaryApiKey = "synthetic-B";
    }
    form.autoSchedulePrimaryFailover = autoSchedule;
    const exported = applyDraftToConfigExport(baseline, form);
    expect(app.config.get()).toEqual(baseline);
    expect(exported.profile_scopes![scope]!.profiles![1]).toEqual(baseline.profile_scopes![scope]!.profiles![1]);
    const imported = await postJson(app.url, "/api/config/import", exported);
    expect(imported.status).toBe(200);
    await imported.text();
    const response = await postJson(app.url, scope === "codex" ? "/v1/responses" : "/anthropic/v1/messages",
      scope === "codex" ? { model: "client-model", input: "synthetic" }
        : { model: "client-model", max_tokens: 32, messages: [{ role: "user", content: "synthetic" }] });
    expect(response.status).toBe(200);
    await response.text();
    expect(received).toEqual([{ upstream: "B", model: "draft-model", key: "Bearer synthetic-B" }]);
  }
});
