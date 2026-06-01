import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  delete process.env.PRIMARY_API_KEY;
});

describe("ConfigStore", () => {
  it("loads defaults and hot patches config to disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

    const configPath = path.join(dir, "compactgate.json");
    const store = await ConfigStore.load(configPath);

    const next = await store.patch({
      primary: { base_url: "http://127.0.0.1:9001/v1" },
      compact: {
        base_url: "http://127.0.0.1:9002/v1",
        model_mode: "custom",
        model_override: "manual-compact"
      },
      logging: { keep_recent: 17 }
    });

    expect(next.primary.base_url).toBe("http://127.0.0.1:9001/v1");
    expect(next.compact.model_mode).toBe("custom");
    expect(next.compact.model_override).toBe("manual-compact");
    expect(next.logging.keep_recent).toBe(17);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      primary: { base_url: "http://127.0.0.1:9001/v1" },
      compact: { model_override: "manual-compact" }
    });
  });

  it("does not expose API key values in public config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

    process.env.PRIMARY_API_KEY = "secret-primary";
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    await store.patch({
      primary: {
        api_key: "saved-primary-key",
        api_key_env: "PRIMARY_API_KEY"
      }
    });
    const publicConfig = store.toPublicConfig();

    expect(JSON.stringify(publicConfig)).not.toContain("secret-primary");
    expect(JSON.stringify(publicConfig)).not.toContain("saved-primary-key");
    expect("api_key" in publicConfig.primary).toBe(false);
    expect(publicConfig.primary.stored_api_key).toBe(true);
    expect(publicConfig.primary.api_key_configured).toBe(true);
  });
});
