import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, parseListenAddress } from "../src/server/config.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("ConfigStore", () => {
  it("loads defaults and hot patches config to disk", async () => {
    const dir = await makeConfigDir();

    const configPath = path.join(dir, "compactgate.json");
    const store = await ConfigStore.load(configPath);

    const next = await store.patch({
      primary: {
        base_url: "http://127.0.0.1:9001/v1",
        reasoning_effort: "high"
      },
      compact: {
        base_url: "http://127.0.0.1:9002/v1",
        model_mode: "custom",
        model_override: "manual-compact"
      },
      logging: { keep_recent: 17, persist_body: true },
      primary_failover: { auto_schedule: false }
    });

    expect(next.primary.base_url).toBe("http://127.0.0.1:9001/v1");
    expect(next.primary.reasoning_effort).toBe("high");
    expect(store.toPublicConfig().primary.reasoning_effort).toBe("high");
    expect(next.compact.model_mode).toBe("custom");
    expect(next.compact.model_override).toBe("manual-compact");
    expect(next.logging.keep_recent).toBe(17);
    expect(next.logging.persist_body).toBe(true);
    expect(next.primary_failover.auto_schedule).toBe(false);
    expect(next.route_url_presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "codex_primary", base_url: "http://127.0.0.1:9001/v1" }),
        expect.objectContaining({ kind: "codex_compact", base_url: "http://127.0.0.1:9002/v1" })
      ])
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      primary: {
        base_url: "http://127.0.0.1:9001/v1",
        reasoning_effort: "high"
      },
      compact: { model_override: "manual-compact" },
      logging: { persist_body: true },
      primary_failover: { auto_schedule: false }
    });
  });

  it("disables raw body persistence by default", async () => {
    const dir = await makeConfigDir();

    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    expect(store.get().logging.persist_body).toBe(false);
    expect(store.toPublicConfig().logging.persist_body).toBe(false);
    expect(store.get().primary.model_override).toBe("");
    expect(store.get().primary.reasoning_effort).toBe("");
  });

  it("rejects unsupported primary reasoning effort values", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await expect(store.patch({
      primary: { reasoning_effort: "ultra" }
    })).rejects.toThrow(
      "primary.reasoning_effort must be empty, none, low, medium, high, xhigh, or max."
    );
  });

  it("rejects listen ports with trailing characters", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    expect(() => parseListenAddress("127.0.0.1:7865abc")).toThrow(
      "listen must contain a valid host and port."
    );
    await expect(store.patch({ listen: "127.0.0.1:7865abc" })).rejects.toThrow(
      "listen must contain a valid host and port."
    );
  });

  it("rejects timeouts above Node's maximum timer delay", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await expect(
      store.patch({
        timeouts: {
          primary_ms: 2_147_483_648
        }
      })
    ).rejects.toThrow("timeouts.primary_ms must be between 1 and 2147483647.");
  });

  it("does not expose API key values in public config", async () => {
    const dir = await makeConfigDir();

    process.env.PRIMARY_API_KEY = "secret-primary";
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    await store.patch({
      primary: {
        api_key: "saved-primary-key",
        api_key_env: "PRIMARY_API_KEY"
      }
    });
    const publicConfig = store.toPublicConfig();
    const savedPreset = store.get().route_url_presets?.find((preset) => preset.kind === "codex_primary");

    expect(JSON.stringify(publicConfig)).not.toContain("secret-primary");
    expect(JSON.stringify(publicConfig)).not.toContain("saved-primary-key");
    expect(JSON.stringify(publicConfig.route_url_presets)).not.toContain("saved-primary-key");
    expect("api_key" in publicConfig.primary).toBe(false);
    expect(publicConfig.primary.stored_api_key).toBe(true);
    expect(publicConfig.primary.api_key_configured).toBe(true);
    expect(savedPreset).toMatchObject({
      api_key: "saved-primary-key",
      api_key_env: "PRIMARY_API_KEY"
    });
    expect(publicConfig.route_url_presets.find((preset) => preset.kind === "codex_primary")).toMatchObject({
      stored_api_key: true,
      api_key_env: "PRIMARY_API_KEY"
    });
  });

  it("restores route credentials from selected URL presets without overriding manual keys", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const presetBaseUrl = "http://127.0.0.1:9051/v1";

    await store.patch({
      primary: {
        base_url: presetBaseUrl,
        api_key: "preset-primary-key",
        api_key_env: "PRESET_PRIMARY_KEY"
      }
    });
    const credentialPresetId =
      store.get().route_url_presets?.find((preset) => preset.kind === "codex_primary" && preset.base_url === presetBaseUrl)?.id ?? "";

    await store.patch({
      primary: {
        base_url: "http://127.0.0.1:9052/v1",
        api_key: "",
        api_key_env: ""
      }
    });
    await store.patch({
      primary: {
        base_url: presetBaseUrl,
        credential_preset_id: credentialPresetId
      }
    });

    expect(store.get().primary).toMatchObject({
      base_url: presetBaseUrl,
      api_key: "preset-primary-key",
      api_key_env: "PRESET_PRIMARY_KEY"
    });

    await store.patch({
      primary: {
        base_url: presetBaseUrl,
        credential_preset_id: credentialPresetId,
        api_key: "manual-primary-key",
        api_key_env: "MANUAL_PRIMARY_KEY"
      }
    });

    expect(store.get().primary).toMatchObject({
      api_key: "manual-primary-key",
      api_key_env: "MANUAL_PRIMARY_KEY"
    });
  });

  it("bounds persisted route URL presets per route kind", async () => {
    const dir = await makeConfigDir();

    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    for (let port = 10_000; port < 10_040; port += 1) {
      await store.patch({
        primary: {
          base_url: `http://127.0.0.1:${port}/v1`
        }
      });
    }

    const config = store.get();
    const primaryPresets = config.route_url_presets?.filter((preset) => preset.kind === "codex_primary") ?? [];
    const primaryPresetUrls = primaryPresets.map((preset) => preset.base_url);

    expect(primaryPresets).toHaveLength(24);
    expect(primaryPresetUrls).toContain("http://127.0.0.1:10039/v1");
    expect(primaryPresetUrls).toContain("http://127.0.0.1:10016/v1");
    expect(primaryPresetUrls).not.toContain("http://127.0.0.1:10015/v1");
    expect(primaryPresetUrls).not.toContain("http://127.0.0.1:10000/v1");
  });

  it("bounds imported route URL preset history per route kind while loading", async () => {
    const dir = await makeConfigDir();

    const configPath = path.join(dir, "compactgate.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          route_url_presets: Array.from({ length: 40 }, (_, index) => ({
            id: `codex-primary-${index}`,
            kind: "codex_primary",
            base_url: `http://127.0.0.1:${11_000 + index}/v1`,
            host: `127.0.0.1:${11_000 + index}`,
            created_at: "2026-06-08T00:00:00.000Z",
            updated_at: `2026-06-08T00:${String(index).padStart(2, "0")}:00.000Z`,
            usage_count: index + 1
          }))
        },
        null,
        2
      )
    );

    const store = await ConfigStore.load(configPath);
    const primaryPresetUrls =
      store.get().route_url_presets?.filter((preset) => preset.kind === "codex_primary").map((preset) => preset.base_url) ?? [];

    expect(primaryPresetUrls).toHaveLength(24);
    expect(primaryPresetUrls).toContain("http://127.0.0.1:11039/v1");
    expect(primaryPresetUrls).toContain("http://127.0.0.1:11016/v1");
    expect(primaryPresetUrls).not.toContain("http://127.0.0.1:11015/v1");
    expect(primaryPresetUrls).not.toContain("http://127.0.0.1:11000/v1");
  });

  it("loads legacy single Claude config as both Claude primary and compact routes", async () => {
    const dir = await makeConfigDir();

    const configPath = path.join(dir, "compactgate.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          claude: {
            base_url: "http://127.0.0.1:9010",
            api_key: "legacy-claude-key",
            api_key_env: "LEGACY_CLAUDE_KEY"
          }
        },
        null,
        2
      )
    );

    const store = await ConfigStore.load(configPath);
    const config = store.get();
    const publicConfig = store.toPublicConfig();

    expect(config.claude.primary).toEqual({
      base_url: "http://127.0.0.1:9010",
      api_key: "legacy-claude-key",
      api_key_env: "LEGACY_CLAUDE_KEY",
      model_override: ""
    });
    expect(config.claude.compact).toEqual({
      ...config.claude.primary,
      upstream_mode: "primary",
      model_override: ""
    });
    expect(publicConfig.claude.primary.base_url).toBe("http://127.0.0.1:9010");
    expect(publicConfig.claude.primary.model_override).toBe("");
    expect(publicConfig.claude.compact.base_url).toBe("http://127.0.0.1:9010");
    expect(publicConfig.claude.compact.upstream_mode).toBe("primary");
    expect(publicConfig.claude.compact.model_override).toBe("");
    expect(publicConfig.claude.primary.stored_api_key).toBe(true);
    expect(publicConfig.claude.compact.stored_api_key).toBe(true);
    expect(JSON.stringify(publicConfig)).not.toContain("legacy-claude-key");
  });

  it("syncs Claude primary model override with the default model map slot", async () => {
    const dir = await makeConfigDir();

    const configPath = path.join(dir, "compactgate.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          claude: {
            primary: {
              base_url: "http://127.0.0.1:9011",
              model_override: "legacy-default-model"
            }
          }
        },
        null,
        2
      )
    );

    const store = await ConfigStore.load(configPath);
    let config = store.get();
    expect(config.claude.primary.model_override).toBe("legacy-default-model");
    expect(config.claude.model_map).toMatchObject({
      default: "legacy-default-model",
      opus: "",
      sonnet: "",
      haiku: "",
      reasoning: "",
      subagent: ""
    });

    await store.patch({
      claude: {
        model_map: {
          default: "mapped-default-model",
          opus: "mapped-opus-model",
          sonnet: "mapped-sonnet-model",
          haiku: "mapped-haiku-model",
          reasoning: "mapped-reasoning-model",
          subagent: "mapped-subagent-model"
        }
      }
    });
    config = store.get();
    expect(config.claude.primary.model_override).toBe("mapped-default-model");
    expect(config.claude.model_map).toMatchObject({
      default: "mapped-default-model",
      opus: "mapped-opus-model",
      sonnet: "mapped-sonnet-model",
      haiku: "mapped-haiku-model",
      reasoning: "mapped-reasoning-model",
      subagent: "mapped-subagent-model"
    });
    expect(store.toPublicConfig().claude.model_map.default).toBe("mapped-default-model");
  });
});
