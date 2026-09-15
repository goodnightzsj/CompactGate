import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StudioKeyActivityEvent } from "../src/shared/types.js";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import { formFromConfig } from "../src/ui/config/config-form-state.js";
import { captureBody, openSseStream, postJson, startApp, startUpstream, writeJsonResponse } from "./helpers/server-test-utils.js";

describe("observed key activity", () => {
  it("observes primary-backed compact attempts but not cache hits or split compact credentials", async () => {
    let calls = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      calls += 1;
      writeJsonResponse(res, { output: [{ type: "compaction", encrypted_content: "synthetic-state" }] });
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary: { api_key: "synthetic-primary" }, compact: { upstream_mode: "primary" }
    });
    const stream = await openSseStream(`${app.url}/api/events`);
    await stream.waitForEvent("snapshot");
    const compact = async () => {
      const response = await postJson(app.url, "/v1/responses/compact", { model: "synthetic-model", input: [] });
      await response.text();
      expect(response.status).toBe(200);
    };
    await compact();
    expect(await stream.waitForEvent("key_activity")).toMatchObject({ scope: "codex", profile_id: null, key_id: "__direct__" });
    await compact();
    expect(calls).toBe(1);
    await expect(stream.waitForEvent("key_activity", 60)).rejects.toThrow("Timed out");
    await app.config.patch({ compact: { upstream_mode: "split", api_key: "synthetic-compact" } });
    await compact();
    expect(calls).toBe(2);
    await expect(stream.waitForEvent("key_activity", 60)).rejects.toThrow("Timed out");
    await stream.close();
  });

  it.each(["codex", "claude"] as const)("reports the actual %s key before completion and follows failure rotation", async (scope) => {
    const sentKeys: string[] = [];
    let releaseResponse = () => {};
    let responseGate = Promise.resolve();
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      sentKeys.push(String(req.headers.authorization ?? req.headers["x-api-key"]));
      await responseGate;
      writeJsonResponse(res, sentKeys.length === 1 ? { error: { message: "invalid api key" } } : {
        id: "synthetic-response", type: "message", object: "response", role: "assistant",
        model: "synthetic-model", content: [{ type: "text", text: "ok" }], output: [],
        usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn"
      }, sentKeys.length === 1 ? 401 : 200);
    });
    const app = await startApp(upstream.url, upstream.url);
    const route = { base_url: upstream.url, api_key: "synthetic-first", api_key_priority: 100,
      api_keys: [{ id: "second", label: "Second", api_key: "synthetic-second", enabled: true, priority: 50 }] };
    await app.config.patch(scope === "codex" ? { primary: route } : { claude: { primary: route } });
    const saved = await app.config.saveProfile(scope, "Synthetic pool", {});
    const profileId = saved.profile_scopes?.[scope]?.profiles?.[0]?.id;
    if (!profileId) throw new Error("Synthetic profile was not saved.");
    await app.config.applyProfile(scope, profileId);
    const stream = await openSseStream(`${app.url}/api/events`);
    await stream.waitForEvent("snapshot");
    const body = scope === "codex" ? { model: "synthetic-model", input: "hello", store: false } : {
      model: "synthetic-model", max_tokens: 20, messages: [{ role: "user", content: "hello" }]
    };
    const endpoint = scope === "codex" ? "/v1/responses" : "/anthropic/v1/messages";
    for (const [index, keyId] of ["__direct__", "second"].entries()) {
      responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
      const pendingResponse = postJson(app.url, endpoint, body);
      const event = await stream.waitForEvent("key_activity") as StudioKeyActivityEvent;
      releaseResponse();
      const response = await pendingResponse;
      await response.text();
      expect(response.status).toBe(index === 0 ? 401 : 200);
      expect(event).toEqual({ scope, profile_id: profileId, key_id: keyId,
        used_at: expect.any(String), config_revision: app.config.revision });
      expect(Number.isFinite(Date.parse(event.used_at))).toBe(true);
      expect(JSON.stringify(event)).not.toContain("synthetic-first");
      expect(JSON.stringify(event)).not.toContain("synthetic-second");

      const config = app.config.toPublicConfig();
      const form = formFromConfig(config);
      const render = (activity: StudioKeyActivityEvent, draft = form) => renderToStaticMarkup(
        <RouteConfigPanel config={config} form={draft} keyActivity={[activity]} scope={scope}
          onFormChange={() => {}} onManageOAuth={() => {}} />);
      expect(render(event)).toContain("Active · 最近选用");
      expect(render({ ...event, profile_id: "other" })).not.toContain("Active · 最近选用");
      expect(render({ ...event, scope: scope === "codex" ? "claude" : "codex" })).not.toContain("Active · 最近选用");
      expect(render({ ...event, config_revision: "old" })).not.toContain("Active · 最近选用");
      const prefix = scope === "codex" ? "codexPrimary" : "claudePrimary";
      const draft = structuredClone(form);
      if (keyId === "__direct__") draft[`${prefix}ApiKey`] = "synthetic-replacement";
      else draft[`${prefix}ApiKeys`][0].apiKey = "synthetic-replacement";
      expect(render(event, draft)).not.toContain("Active · 最近选用");
    }
    expect(sentKeys[0]).toContain("synthetic-first");
    expect(sentKeys[1]).toContain("synthetic-second");
    await postJson(app.url, "/api/test-route", { path: "/v1/responses", body: { model: "synthetic-model", input: "preview" } });
    await expect(stream.waitForEvent("key_activity", 60)).rejects.toThrow("Timed out");
    await stream.close();
  });
});
