import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

async function loadStore(): Promise<ConfigStore> {
  return ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
}

describe("config writes cannot pair one route's URL with another's credential", () => {
  it("keeps a by-name overwrite internally coherent", async () => {
    const store = await loadStore();

    await store.saveProfile("codex", "Prod", {
      primary: { base_url: "https://prod.example/v1", api_key: "sk-prod" }
    });
    const dev = await store.saveProfile("codex", "Dev", {
      primary: { base_url: "https://dev.example/v1", api_key: "sk-dev" }
    });
    const devId = dev.profile_scopes?.codex?.profiles?.find((p) => p.name === "Dev")?.id ?? "";
    await store.applyProfile("codex", devId);

    // The overwrite-confirm dialog sends the live form with no override, so the
    // patch carries the *runtime's* base_url and omits the untouched api_key.
    // Whatever the merge base is, the URL and the key it lands beside must come
    // from the same place — basing it on the target instead produced Dev's URL
    // with Prod's key, a profile that 401s and cannot be repaired from the UI.
    const after = await store.saveProfile("codex", "Prod", {
      primary: { base_url: "https://dev.example/v1" }
    });

    const prod = after.profile_scopes?.codex?.profiles?.find((p) => p.name === "Prod");
    expect(prod?.config).toMatchObject({
      primary: { base_url: "https://dev.example/v1", api_key: "sk-dev" }
    });
  });

  it("keeps stored preset credentials that a patch does not restate", async () => {
    const store = await loadStore();

    // Saving a profile records the URL as a preset together with its key.
    await store.saveProfile("codex", "Prod", {
      primary: { base_url: "https://preset.example/v1", api_key: "sk-preset" }
    });
    const preset = store.get().route_url_presets?.find((item) => item.kind === "codex_primary");
    expect(preset?.api_key).toBe("sk-preset");

    // A client can only ever echo back the redacted public shape, which has no
    // api_key at all. Reading that as "" wiped every stored key.
    await store.patch({
      route_url_presets: [
        {
          id: preset?.id,
          kind: "codex_primary",
          base_url: "https://preset.example/v1",
          api_key_env: "",
          host: "preset.example",
          created_at: preset?.created_at,
          updated_at: preset?.updated_at,
          usage_count: 1
        }
      ]
    });

    expect(
      store.get().route_url_presets?.find((item) => item.id === preset?.id)?.api_key
    ).toBe("sk-preset");

    // An explicit empty string still clears it.
    await store.patch({
      route_url_presets: [
        {
          id: preset?.id,
          kind: "codex_primary",
          base_url: "https://preset.example/v1",
          api_key: "",
          api_key_env: ""
        }
      ]
    });
    expect(
      store.get().route_url_presets?.find((item) => item.id === preset?.id)?.api_key
    ).toBe("");
  });

  it("matches a preset by route and URL, not by a restated id", async () => {
    const store = await loadStore();
    await store.saveProfile("codex", "Prod", {
      primary: { base_url: "https://match.example/v1", api_key: "sk-match" }
    });
    const preset = store.get().route_url_presets?.find((item) => item.kind === "codex_primary");

    // No id, and a trailing slash: the derived id differs from the stored one, so
    // an id-keyed lookup silently kept the wipe.
    await store.patch({
      route_url_presets: [
        { kind: "codex_primary", base_url: "https://match.example/v1/", api_key_env: "" }
      ]
    });
    // `withRecordedRouteUrlPresets` re-registers the runtime's own four routes
    // after the merge, so select by URL rather than by kind.
    expect(
      store.get().route_url_presets?.find(
        (item) => item.base_url.startsWith("https://match.example/v1")
      )?.api_key
    ).toBe("sk-match");

    // The stored id paired with a different host must NOT carry the secret over.
    await store.patch({
      route_url_presets: [
        { id: preset?.id, kind: "codex_primary", base_url: "https://elsewhere.example/v1" }
      ]
    });
    const moved = store.get().route_url_presets?.find(
      (item) => item.base_url === "https://elsewhere.example/v1"
    );
    expect(moved).toBeTruthy();
    expect(moved?.api_key).toBe("");
  });

  it("rejects duplicate profile ids instead of locking reorder forever", async () => {
    const store = await loadStore();

    const saved = await store.saveProfile("codex", "One", {
      primary: { base_url: "https://one.example/v1" }
    });
    const profile = saved.profile_scopes?.codex?.profiles?.[0];
    expect(profile).toBeTruthy();

    await expect(store.patch({
      profile_scopes: {
        codex: {
          profiles: [profile, { ...profile, name: "Two" }],
          active_profile_id: profile?.id
        }
      }
    })).rejects.toThrow(/unique/i);

    // Reorder still works, which it could not have with the duplicate stored:
    // the payload would have to repeat the id, and repeats are rejected.
    const second = await store.saveProfile("codex", "Two", {
      primary: { base_url: "https://two.example/v1" }
    });
    const ids = (second.profile_scopes?.codex?.profiles ?? []).map((item) => item.id);
    const reordered = await store.reorderProfiles("codex", [...ids].reverse());
    expect((reordered.profile_scopes?.codex?.profiles ?? []).map((item) => item.id))
      .toEqual([...ids].reverse());
  });
});
