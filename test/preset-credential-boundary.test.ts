import { expect, it } from "vitest";
import { resolveRouteCredential } from "../src/server/credentials.js";
import { applyDraftToConfigExport, formFromConfig, formToPatch } from "../src/ui/config/config-form-state.js";
import { startApp, startUpstream, writeJsonResponse } from "./helpers/server-test-utils.js";

it.each(["codex", "claude"] as const)("isolates %s compact pools across a preset export and import", async scope => {
  const app = await startApp();
  const patch = (compact: unknown) => scope === "codex" ? { compact } : { claude: { compact } };
  await app.config.patch(patch({ base_url: "http://b.invalid", api_key: "synthetic-B", api_key_env: "", api_keys: [], upstream_mode: "split" }));
  const preset = app.config.get().route_url_presets!.find(p => p.kind === `${scope}_compact` && p.base_url === "http://b.invalid")!;
  const pool = [{ id: "pool", label: "Saved", api_key: "synthetic-pool", enabled: true, priority: 100 }];
  await app.config.patch(patch({ api_keys: pool }));
  for (const sameTarget of [true, false]) {
    if (!sameTarget) await app.config.patch(patch({ base_url: "http://a.invalid", api_key: "synthetic-A" }));
    const form = formFromConfig(app.config.toPublicConfig());
    if (scope === "codex") {
      form.codexCompactBaseUrl = `${preset.base_url}/`;
      form.codexCompactCredentialPresetId = preset.id;
    } else {
      form.claudeCompactBaseUrl = `${preset.base_url}/`;
      form.claudeCompactCredentialPresetId = preset.id;
    }
    const exported = applyDraftToConfigExport(app.config.get(), form);
    await app.config.importConfig(exported);
    expect(resolveRouteCredential(scope === "codex" ? "compact" : "claude_compact", app.config.get()).apiKey)
      .toBe(sameTarget ? "synthetic-pool" : "synthetic-B");
    expect((scope === "codex" ? app.config.get().compact : app.config.get().claude.compact).api_keys ?? []).toEqual(sameTarget ? pool : []);
  }
});

it.each(["codex", "claude"] as const)("isolates %s pool credentials when selecting another URL preset", async scope => {
  const received: string[] = [];
  const upstream = await startUpstream((req, res) => {
    received.push(String(req.headers.authorization ?? req.headers["x-api-key"]));
    writeJsonResponse(res, { object: "list", data: [] });
  });
  const app = await startApp();
  const patch = (primary: unknown) => scope === "codex" ? { primary } : { claude: { primary } };
  await app.config.patch(patch({ base_url: upstream.url, api_key: "synthetic-B", api_key_env: "", api_keys: [] }));
  const preset = app.config.get().route_url_presets!.find(p => p.kind === `${scope}_primary` && p.base_url === upstream.url)!;
  await app.config.patch(patch({ base_url: "http://127.0.0.1:1", api_key: "synthetic-A", api_key_env: "", api_keys: [
    { id: "a-only", label: "A", api_key: "synthetic-A-pool", enabled: true, priority: 100 }
  ] }));
  const form = formFromConfig(app.config.toPublicConfig());
  if (scope === "codex") {
    form.codexPrimaryBaseUrl = preset.base_url;
    form.codexPrimaryCredentialPresetId = preset.id;
  } else {
    form.claudePrimaryBaseUrl = preset.base_url;
    form.claudePrimaryCredentialPresetId = preset.id;
  }
  const exported = applyDraftToConfigExport(app.config.get(), form);
  const exportedRoute = scope === "codex" ? exported.primary : exported.claude.primary;
  expect(exportedRoute.api_keys ?? []).toEqual([]);
  const saved = await fetch(`${app.url}/api/config`, {
    method: "PATCH", body: JSON.stringify({ ...formToPatch(form), revision: app.config.revision })
  });
  expect(saved.status).toBe(200);
  await saved.text();
  const response = await fetch(`${app.url}${scope === "codex" ? "/v1/models" : "/anthropic/v1/models"}`);
  expect(response.status).toBe(200);
  await response.text();
  expect(received).toEqual(["Bearer synthetic-B"]);

  await app.config.patch(patch({ api_keys: [{ id: "b-pool", api_key: "synthetic-new", enabled: true }] }));
  await app.config.patch(patch({ base_url: `${preset.base_url}/`, credential_preset_id: preset.id,
    api_keys: [{ id: "b-pool", label: "renamed" }] }));
  const current = app.config.get();
  expect((scope === "codex" ? current.primary : current.claude.primary).api_keys?.[0].api_key).toBe("synthetic-new");
});
