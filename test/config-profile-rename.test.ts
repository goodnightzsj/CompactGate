import { expect, it } from "vitest";
import { startApp } from "./helpers/server-test-utils.js";

it.each(["codex", "claude"] as const)("renaming an inactive %s profile preserves URL preset credentials", async scope => {
  const app = await startApp();
  const sharedUrl = "https://synthetic-shared.invalid/v1";
  await app.config.saveProfile(scope, "Old account", scope === "codex" ? { primary: { base_url: sharedUrl, api_key: "synthetic-old" } } : { claude: { primary: { base_url: sharedUrl, api_key: "synthetic-old", api_key_env: "" } } });
  const inactiveId = app.config.toPublicConfig().profile_scopes[scope].profiles[0]!.id;
  await app.config.patch(scope === "codex" ? { primary: { base_url: sharedUrl, api_key: "synthetic-current" } } : { claude: { primary: { base_url: sharedUrl, api_key: "synthetic-current", api_key_env: "" } } });
  const before = app.config.get().route_url_presets!.find(preset => preset.kind === `${scope}_primary` && preset.base_url === sharedUrl)!;
  expect(before.api_key).toBe("synthetic-current");
  const response = await fetch(`${app.url}/api/config/profiles`, {
    method: "PATCH", body: JSON.stringify({ scope, profile_id: inactiveId, name: "Renamed account", revision: app.config.revision })
  });
  expect(response.status).toBe(200);
  await response.json();
  const after = app.config.get().route_url_presets!.find(preset => preset.id === before.id)!;
  expect((scope === "codex" ? app.config.get().primary : app.config.get().claude.primary).api_key).toBe("synthetic-current");
  expect(after).toEqual(before);
  await app.config.patch(scope === "codex" ? { primary: { base_url: sharedUrl, credential_preset_id: after.id } } : { claude: { primary: { base_url: sharedUrl, credential_preset_id: after.id } } });
  expect((scope === "codex" ? app.config.get().primary : app.config.get().claude.primary).api_key).toBe("synthetic-current");
});
