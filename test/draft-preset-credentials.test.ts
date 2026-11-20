import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { resolveUpstreamCredential } from "../src/server/credentials.js";
import { applyDraftToConfigExport, formFromConfig, formToPatch } from "../src/ui/config/config-form-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";
import { startApp, startUpstream, writeJsonResponse } from "./helpers/server-test-utils.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["primary", "compact", "claude_primary", "claude_compact"] as const)(
  "exported %s draft uses the same credential as saving after clear-then-select-preset", async kind => {
    vi.stubEnv("AUDIT_OLD_KEY", "synthetic-secret-for-old-host");
    vi.stubEnv("AUDIT_NEW_KEY", "synthetic-secret-for-new-host");
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "config.json"));
    const routePatch = (value: Record<string, unknown>) => kind === "primary" || kind === "compact"
      ? { [kind]: value } : { claude: { [kind === "claude_primary" ? "primary" : "compact"]: value } };
    const routeOf = (config: ReturnType<ConfigStore["get"]>) => kind === "primary" || kind === "compact"
      ? config[kind] : config.claude[kind === "claude_primary" ? "primary" : "compact"];
    const presetKind = kind === "primary" || kind === "compact" ? `codex_${kind}` : kind;
    await store.patch(routePatch({ base_url: "https://new.example.invalid/v1", api_key: "", api_key_env: "AUDIT_NEW_KEY" }));
    await store.patch(routePatch({ base_url: "https://old.example.invalid/v1", api_key: "synthetic-old-direct", api_key_env: "AUDIT_OLD_KEY" }));
    const preset = store.toPublicConfig().route_url_presets.find(item => item.kind === presetKind && item.base_url.includes("new.example"))!;
    const prefix = { primary: "codexPrimary", compact: "codexCompact", claude_primary: "claudePrimary", claude_compact: "claudeCompact" }[kind];
    // Selecting a preset retains the explicit clear toggle in either edit order.
    const draft = {
      ...formFromConfig(store.toPublicConfig()),
      [`clear${prefix[0].toUpperCase()}${prefix.slice(1)}ApiKey`]: true,
      [`${prefix}BaseUrl`]: preset.base_url,
      [`${prefix}CredentialPresetId`]: preset.id
    };
    const exported = applyDraftToConfigExport(store.get(), draft);
    await store.patch(JSON.parse(JSON.stringify(formToPatch(draft))));
    const saved = store.get();
    expect(resolveUpstreamCredential("primary", routeOf(saved)).apiKey).toBe("synthetic-secret-for-new-host");
    await store.importConfig(exported);
    expect(routeOf(store.get()).base_url).toBe(routeOf(saved).base_url);
    expect(resolveUpstreamCredential("primary", routeOf(store.get())).apiKey).toBe("synthetic-secret-for-new-host");
  }
);

it("restored draft sends only the selected preset's credential to the selected upstream", async () => {
  vi.stubEnv("AUDIT_OLD_KEY", "synthetic-old-environment-secret");
  vi.stubEnv("AUDIT_NEW_KEY", "synthetic-new-environment-secret");
  const captured: unknown[] = [];
  const selectedUpstream = await startUpstream((req, res) => {
    captured.push(req.headers.authorization);
    writeJsonResponse(res, { object: "list", data: [] });
  });
  const app = await startApp();
  await app.config.patch({ primary: { base_url: selectedUpstream.url, api_key: "", api_key_env: "AUDIT_NEW_KEY" } });
  await app.config.patch({ primary: { base_url: "http://127.0.0.1:1/v1", api_key: "synthetic-old-direct", api_key_env: "AUDIT_OLD_KEY" } });
  const preset = app.config.toPublicConfig().route_url_presets.find(item => item.kind === "codex_primary" && item.base_url === selectedUpstream.url)!;
  const draft = { ...formFromConfig(app.config.toPublicConfig()), clearCodexPrimaryApiKey: true,
    codexPrimaryBaseUrl: preset.base_url, codexPrimaryCredentialPresetId: preset.id };
  const exported = applyDraftToConfigExport(app.config.get(), draft);
  await app.config.patch(JSON.parse(JSON.stringify(formToPatch(draft))));
  expect((await fetch(`${app.url}/v1/models`)).status).toBe(200);
  await app.config.importConfig(exported);
  expect((await fetch(`${app.url}/v1/models`)).status).toBe(200);
  expect(captured).toEqual(["Bearer synthetic-new-environment-secret", "Bearer synthetic-new-environment-secret"]);
});

it.each(["primary", "compact", "claude_primary", "claude_compact"] as const)("restoring a credential-edited %s draft keeps the same URL preset credential as saving it", async kind => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "config.json"));
  const routePatch = (value: Record<string, unknown>) => kind === "primary" || kind === "compact"
    ? { [kind]: value } : { claude: { [kind === "claude_primary" ? "primary" : "compact"]: value } };
  const routeOf = () => kind === "primary" || kind === "compact"
    ? store.get()[kind] : store.get().claude[kind === "claude_primary" ? "primary" : "compact"];
  const prefix = { primary: "codexPrimary", compact: "codexCompact", claude_primary: "claudePrimary", claude_compact: "claudeCompact" }[kind];
  const presetKind = kind === "primary" || kind === "compact" ? `codex_${kind}` : kind;
  const selectedUrl = "https://selected.example.invalid/v1";
  await store.patch(routePatch({ base_url: "https://historical.example.invalid/v1", api_key: "synthetic-history", api_key_env: "" }));
  await store.patch(routePatch({ base_url: selectedUrl, api_key: "synthetic-before-rotation", api_key_env: "" }));
  const baseline = store.get();
  const draft = { ...formFromConfig(store.toPublicConfig()), [`${prefix}ApiKey`]: "synthetic-after-rotation" };
  const exported = applyDraftToConfigExport(store.get(), draft);
  expect(exported.route_url_presets!.find(item => item.kind === presetKind && item.base_url.includes("historical"))?.api_key).toBe("synthetic-history");
  expect(baseline.route_url_presets!.find(item => item.kind === presetKind && item.base_url === selectedUrl)?.api_key).toBe("synthetic-before-rotation");
  await store.patch(JSON.parse(JSON.stringify(formToPatch(draft))));
  const expected = store.get().route_url_presets!.find(item => item.kind === presetKind && item.base_url === selectedUrl)!;
  expect(expected.api_key).toBe("synthetic-after-rotation");
  await store.importConfig(exported);
  await store.patch(routePatch({ base_url: "https://other.example.invalid/v1", api_key: "synthetic-other" }));
  await store.patch(routePatch({ base_url: selectedUrl, credential_preset_id: expected.id }));
  expect(routeOf().api_key).toBe("synthetic-after-rotation");
});

it("a selected preset with an empty env cannot inherit the prior host's env on draft restore", async () => {
  vi.stubEnv("AUDIT_OLD_KEY", "synthetic-old-environment-secret");
  const captured: unknown[] = [];
  const selectedUpstream = await startUpstream((req, res) => {
    captured.push(req.headers.authorization);
    writeJsonResponse(res, { object: "list", data: [] });
  });
  const app = await startApp();
  await app.config.patch({ primary: { base_url: selectedUpstream.url, api_key: "synthetic-preset-direct", api_key_env: "" } });
  await app.config.patch({ primary: { base_url: "http://127.0.0.1:1/v1", api_key: "synthetic-old-direct", api_key_env: "AUDIT_OLD_KEY" } });
  const preset = app.config.toPublicConfig().route_url_presets.find(item => item.kind === "codex_primary" && item.base_url === selectedUpstream.url)!;
  const draft = { ...formFromConfig(app.config.toPublicConfig()), clearCodexPrimaryApiKey: true,
    codexPrimaryBaseUrl: preset.base_url, codexPrimaryCredentialPresetId: preset.id };
  const exported = applyDraftToConfigExport(app.config.get(), draft);
  await app.config.patch(JSON.parse(JSON.stringify(formToPatch(draft))));
  expect(app.config.get().primary.api_key_env).toBe("");
  expect((await fetch(`${app.url}/v1/models`)).status).toBe(200);
  await app.config.importConfig(exported);
  expect((await fetch(`${app.url}/v1/models`)).status).toBe(200);
  expect(captured).toEqual([undefined, undefined]);
});
