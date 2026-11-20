import path from "node:path";
import { expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

it("keeps preset IDs unambiguous after changing a saved preset URL", async () => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "synthetic.json"));
  try {
    const originalUrl = "https://synthetic-current.invalid/v1";
    await store.patch({ primary: { base_url: originalUrl, api_key: "synthetic-current" } });
    const original = store.get().route_url_presets!.find(preset => preset.kind === "codex_primary" && preset.base_url === originalUrl)!;
    await store.patch({ route_url_presets: [{ ...original, base_url: "https://synthetic-updated.invalid/v1", api_key: "synthetic-updated" }] });
    const presets = store.get().route_url_presets!.filter(preset => preset.kind === "codex_primary");
    expect.soft(new Set(presets.map(preset => preset.id)).size).toBe(presets.length);
    for (const preset of presets) {
      await expect(store.patch({ primary: { base_url: preset.base_url, credential_preset_id: preset.id } }))
        .resolves.toMatchObject({ primary: { base_url: preset.base_url, api_key: preset.api_key } });
    }
  } finally { store.oauth.close(); }
});

it.each(["import", "patch"] as const)("rejects duplicate preset IDs within a kind during %s", async operation => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "synthetic.json"));
  try {
    const before = store.get();
    const presets = [
      { id: "same", kind: "codex_primary", base_url: "https://one.synthetic.invalid", api_key: "synthetic-one" },
      { id: "same", kind: "codex_primary", base_url: "https://two.synthetic.invalid", api_key: "synthetic-two" }
    ];
    const update = { route_url_presets: presets };
    await expect(operation === "import" ? store.importConfig(update) : store.patch(update)).rejects.toThrow("URL preset ids must be unique");
    expect(store.get()).toEqual(before);
    presets[1].kind = "claude_primary";
    await expect(store.importConfig(update)).resolves.toBeTruthy();
    await expect(store.patch({ primary: { credential_preset_id: "same" } }))
      .resolves.toMatchObject({ primary: { base_url: presets[0].base_url, api_key: "synthetic-one" } });
  } finally { store.oauth.close(); }
});
