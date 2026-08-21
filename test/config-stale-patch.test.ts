import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

/**
 * A Studio tab holds the config snapshot it loaded. If another tab applies a
 * different profile in the meantime, the first tab's save still carries the old
 * base_url while omitting the (blank) api_key field, so the merge pairs one
 * provider's URL with another provider's stored key.
 */
describe("stale config patches", () => {
  it("rejects a patch built against a superseded config revision", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    const dev = await store.saveProfile("codex", "Dev", {
      primary: { base_url: "https://dev.example/v1", api_key: "sk-dev" }
    });
    const devId = dev.profile_scopes?.codex?.profiles?.[0]?.id ?? "";
    const prod = await store.saveProfile("codex", "Prod", {
      primary: { base_url: "https://prod.example/v1", api_key: "sk-prod" }
    });
    const prodId = prod.profile_scopes?.codex?.profiles?.find((p) => p.name === "Prod")?.id ?? "";
    expect(devId && prodId).toBeTruthy();

    // Tab A loads the config while Dev is active.
    await store.applyProfile("codex", devId);
    const staleRevision = store.toPublicConfig().revision;

    // Tab B switches to Prod.
    await store.applyProfile("codex", prodId);
    expect(store.get().primary.api_key).toBe("sk-prod");

    // Tab A saves an unrelated edit. Its payload still carries Dev's base_url
    // and omits api_key, exactly as formToPatch builds it for a blank key field.
    await expect(store.patch({
      revision: staleRevision,
      primary: { base_url: "https://dev.example/v1" },
      logging: { keep_recent: 300 }
    })).rejects.toThrow(/superseded|revision/i);

    // Neither the runtime nor the stored Prod profile may be corrupted.
    const after = store.get();
    expect(after.primary.base_url).toBe("https://prod.example/v1");
    expect(after.primary.api_key).toBe("sk-prod");
    const storedProd = after.profile_scopes?.codex?.profiles?.find((p) => p.id === prodId);
    expect(storedProd?.config).toMatchObject({
      primary: { base_url: "https://prod.example/v1" }
    });
  });

  it("accepts a patch that carries the current revision", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    const revision = store.toPublicConfig().revision;
    const next = await store.patch({ revision, logging: { keep_recent: 321 } });

    expect(next.logging.keep_recent).toBe(321);
    expect(store.toPublicConfig().revision).not.toBe(revision);
  });

  it("accepts a patch with no revision so existing clients keep working", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    const next = await store.patch({ logging: { keep_recent: 250 } });
    expect(next.logging.keep_recent).toBe(250);
  });
});
