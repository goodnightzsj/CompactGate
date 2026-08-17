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
        reasoning_effort: "high",
        state_domain_id: "shared-codex"
      },
      compact: {
        base_url: "http://127.0.0.1:9002/v1",
        model_mode: "custom",
        model_override: "manual-compact"
      },
      logging: { keep_recent: 17, persist_body: true },
      primary_failover: {
        auto_schedule: false,
        state_portability: "recover_on_error"
      }
    });

    expect(next.primary.base_url).toBe("http://127.0.0.1:9001/v1");
    expect(next.primary.reasoning_effort).toBe("high");
    expect(next.primary.state_domain_id).toBe("shared-codex");
    expect(store.toPublicConfig().primary.reasoning_effort).toBe("high");
    expect(next.compact.model_mode).toBe("custom");
    expect(next.compact.model_override).toBe("manual-compact");
    expect(next.logging.keep_recent).toBe(17);
    expect(next.logging.persist_body).toBe(true);
    expect(next.primary_failover.auto_schedule).toBe(false);
    expect(next.primary_failover.state_portability).toBe("recover_on_error");
    expect(next.route_url_presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "codex_primary", base_url: "http://127.0.0.1:9001/v1" }),
        expect.objectContaining({ kind: "codex_compact", base_url: "http://127.0.0.1:9002/v1" })
      ])
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      primary: {
        base_url: "http://127.0.0.1:9001/v1",
        reasoning_effort: "high",
        state_domain_id: "shared-codex"
      },
      compact: { model_override: "manual-compact" },
      logging: { persist_body: true },
      primary_failover: { auto_schedule: false, state_portability: "recover_on_error" }
    });
  });

  it("disables raw body persistence by default", async () => {
    const dir = await makeConfigDir();

    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    expect(store.get().logging.persist_body).toBe(false);
    expect(store.toPublicConfig().logging.persist_body).toBe(false);
    expect(store.get().primary.model_override).toBe("");
    expect(store.get().primary.upstream_protocol).toBe("openai_responses");
    expect(store.get().compact.upstream_protocol).toBe("openai_responses");
    expect(store.get().claude.primary.upstream_protocol).toBe("anthropic_messages");
    expect(store.get().claude.compact.upstream_protocol).toBe("anthropic_messages");
    expect(store.get().primary.reasoning_effort).toBe("");
    expect(store.get().primary_failover.state_portability).toBe("recover_on_error");
  });

  it("round-trips explicit upstream protocols and rejects unsupported values", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await store.patch({
      primary: { upstream_protocol: "anthropic_messages" },
      compact: { upstream_protocol: "anthropic_messages" },
      claude: {
        primary: { upstream_protocol: "openai_responses" },
        compact: { upstream_protocol: "openai_chat" }
      }
    });

    expect(store.toPublicConfig()).toMatchObject({
      primary: { upstream_protocol: "anthropic_messages" },
      compact: { upstream_protocol: "anthropic_messages" },
      claude: {
        primary: { upstream_protocol: "openai_responses" },
        compact: { upstream_protocol: "openai_chat" }
      }
    });
    await expect(store.patch({ primary: { upstream_protocol: "auto" } })).rejects.toThrow(
      "primary.upstream_protocol must be openai_responses, anthropic_messages, or openai_chat."
    );
  });

  it("normalizes legacy provider-state portability modes on load", async () => {
    for (const legacyMode of ["compatibility_first", "domain_aware"]) {
      const dir = await makeConfigDir();
      const configPath = path.join(dir, "compactgate.json");
      await writeFile(configPath, JSON.stringify({
        primary_failover: {
          auto_schedule: false,
          state_portability: legacyMode
        }
      }));

      const store = await ConfigStore.load(configPath);

      expect(store.get().primary_failover).toEqual({
        auto_schedule: false,
        state_portability: "recover_on_error"
      });
      expect(store.toPublicConfig().primary_failover.state_portability).toBe("recover_on_error");
    }
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
      extra_headers: {},
      proxy_url: "",
      upstream_protocol: "anthropic_messages",
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

  it("validates, persists, and redacts configured upstream headers", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await store.patch({
      primary: {
        extra_headers: {
          "X-Tenant-Secret": "s3cr3t-value",
          "x-feature-mode": "strict"
        }
      }
    });

    expect(store.get().primary.extra_headers).toEqual({
      "x-tenant-secret": "s3cr3t-value",
      "x-feature-mode": "strict"
    });
    expect(store.toPublicConfig().primary.extra_header_names).toEqual([
      "x-feature-mode",
      "x-tenant-secret"
    ]);
    expect(JSON.stringify(store.toPublicConfig())).not.toContain("s3cr3t-value");
    expect(store.get().route_url_presets?.find((preset) => preset.kind === "codex_primary"))
      .not.toHaveProperty("extra_headers");

    const saved = await store.saveProfile("codex", "Transport headers", {
      primary: { extra_headers: { "x-profile-secret": "profile-value" } }
    });
    const profile = saved.profile_scopes?.codex?.profiles?.find(
      (candidate) => candidate.name === "Transport headers"
    );
    expect(profile?.config).toMatchObject({
      primary: {
        extra_headers: { "x-profile-secret": "profile-value" }
      }
    });
    expect(JSON.stringify(store.toPublicConfig())).not.toContain("profile-value");

    await expect(store.patch({
      primary: { extra_headers: { Authorization: "Bearer bypass" } }
    })).rejects.toThrow("cannot override a protected header");
    await expect(store.patch({
      primary: { extra_headers: { "x-unsafe": "line-one\r\nline-two" } }
    })).rejects.toThrow("must be a valid HTTP header");
    await expect(store.patch({
      primary: { extra_headers: { "x-valid": 42 } }
    })).rejects.toThrow("extra_headers must be a JSON object containing string values");
  });

  it("validates explicit HTTP CONNECT proxy configuration without exposing credentials", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await store.patch({
      primary: {
        base_url: "https://api.example.test/v1",
        proxy_url: "http://proxy-user:proxy-pass@127.0.0.1:8080"
      }
    });

    expect(store.get().primary.proxy_url).toContain("proxy-user:proxy-pass");
    expect(store.toPublicConfig().primary).toMatchObject({
      proxy_configured: true,
      proxy_host: "127.0.0.1:8080",
      proxy_authenticated: true
    });
    expect(JSON.stringify(store.toPublicConfig())).not.toContain("proxy-pass");
    expect(store.get().route_url_presets?.find((preset) => preset.kind === "codex_primary"))
      .not.toHaveProperty("proxy_url");

    await expect(store.patch({
      primary: { proxy_url: "https://127.0.0.1:8080" }
    })).rejects.toThrow("must be an http URL without a path, query, or fragment");
    await expect(store.patch({
      primary: {
        base_url: "http://127.0.0.1:9000/v1",
        proxy_url: "http://127.0.0.1:8080"
      }
    })).rejects.toThrow("requires an https upstream URL");
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
