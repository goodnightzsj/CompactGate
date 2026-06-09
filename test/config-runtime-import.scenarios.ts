import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("ConfigStore", () => {
  it("syncs runtime config when updating active scoped profiles", async () => {
    const dir = await makeConfigDir();

    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    await store.saveProfile("codex", "Codex active", {
      primary: { base_url: "http://127.0.0.1:9801/v1" },
      compact: {
        base_url: "http://127.0.0.1:9802/v1",
        model_mode: "custom",
        model_override: "codex-active-model"
      }
    });
    await store.saveProfile("codex", "Codex inactive", {
      primary: { base_url: "http://127.0.0.1:9811/v1" },
      compact: { base_url: "http://127.0.0.1:9812/v1" }
    });
    await store.saveProfile("claude", "Claude active", {
      claude: {
        primary: { base_url: "http://127.0.0.1:9821" },
        compact: { base_url: "http://127.0.0.1:9822", upstream_mode: "primary" }
      }
    });

    const saved = store.get();
    const codexActiveId = saved.profile_scopes?.codex?.profiles?.find((profile) => profile.name === "Codex active")?.id ?? "";
    const codexInactiveId = saved.profile_scopes?.codex?.profiles?.find((profile) => profile.name === "Codex inactive")?.id ?? "";
    const claudeActiveId = saved.profile_scopes?.claude?.profiles?.find((profile) => profile.name === "Claude active")?.id ?? "";
    expect(codexActiveId).toBeTruthy();
    expect(codexInactiveId).toBeTruthy();
    expect(claudeActiveId).toBeTruthy();

    await store.applyProfile("codex", codexActiveId);
    await store.applyProfile("claude", claudeActiveId);
    await store.saveProfile("codex", "Codex active", {
      primary: { base_url: "http://127.0.0.1:9891/v1" },
      compact: {
        model_mode: "custom",
        model_override: "codex-resaved-model"
      }
    });

    let updated = store.get();
    expect(updated.primary.base_url).toBe("http://127.0.0.1:9891/v1");
    expect(updated.compact.model_override).toBe("codex-resaved-model");
    expect(updated.profile_scopes?.codex?.active_profile_id).toBe(codexActiveId);

    await store.updateProfile("codex", codexActiveId, "Codex active", {
      primary: { base_url: "http://127.0.0.1:9901/v1" },
      compact: { model_override: "codex-updated-model" },
      claude: {
        primary: { base_url: "http://127.0.0.1:9998" }
      }
    });

    updated = store.get();
    expect(updated.primary.base_url).toBe("http://127.0.0.1:9901/v1");
    expect(updated.compact.model_override).toBe("codex-updated-model");
    expect(updated.claude.primary.base_url).toBe("http://127.0.0.1:9821");
    expect(updated.profile_scopes?.codex?.active_profile_id).toBe(codexActiveId);
    expect(updated.profile_scopes?.claude?.active_profile_id).toBe(claudeActiveId);

    await store.updateProfile("claude", claudeActiveId, "Claude active", {
      claude: {
        primary: { base_url: "http://127.0.0.1:9921" },
        compact: { base_url: "http://127.0.0.1:9922", upstream_mode: "split" }
      },
      primary: { base_url: "http://127.0.0.1:9999/v1" }
    });

    updated = store.get();
    expect(updated.primary.base_url).toBe("http://127.0.0.1:9901/v1");
    expect(updated.claude.primary.base_url).toBe("http://127.0.0.1:9921");
    expect(updated.claude.compact.base_url).toBe("http://127.0.0.1:9922");
    expect(updated.claude.compact.upstream_mode).toBe("split");

    await store.updateProfile("codex", codexInactiveId, "Codex inactive", {
      primary: { base_url: "http://127.0.0.1:9931/v1" },
      compact: { model_override: "inactive-updated-model" }
    });
    await store.saveProfile("codex", "Codex inactive", {
      primary: { base_url: "http://127.0.0.1:9941/v1" },
      compact: {
        model_mode: "custom",
        model_override: "inactive-resaved-model"
      }
    });

    updated = store.get();
    expect(updated.primary.base_url).toBe("http://127.0.0.1:9901/v1");
    expect(updated.compact.model_override).toBe("codex-updated-model");
    expect(
      updated.profile_scopes?.codex?.profiles?.find((profile) => profile.id === codexInactiveId)?.config
    ).toMatchObject({
      primary: { base_url: "http://127.0.0.1:9941/v1" },
      compact: { model_override: "inactive-resaved-model" }
    });
  });

  it("imports a full config without recording URL preset usage or rewriting active profiles", async () => {
    const dir = await makeConfigDir();

    const configPath = path.join(dir, "compactgate.json");
    const store = await ConfigStore.load(configPath);
    await store.patch({
      primary: { base_url: "http://127.0.0.1:9951/v1" },
      compact: { base_url: "http://127.0.0.1:9952/v1" }
    });

    const imported = await store.importConfig({
      listen: "127.0.0.1:7965",
      primary: {
        base_url: "http://127.0.0.1:9961/v1",
        api_key: "import-primary-key",
        api_key_env: ""
      },
      compact: {
        base_url: "http://127.0.0.1:9962/v1",
        api_key: "",
        api_key_env: "",
        upstream_mode: "split",
        model_mode: "custom",
        model_template: "{model}-imported",
        model_override: "imported-compact-model"
      },
      claude: {
        primary: {
          base_url: "http://127.0.0.1:9963",
          api_key: "",
          api_key_env: "ANTHROPIC_AUTH_TOKEN",
          model_override: "imported-claude-default"
        },
        compact: {
          base_url: "http://127.0.0.1:9964",
          api_key: "",
          api_key_env: "ANTHROPIC_AUTH_TOKEN",
          upstream_mode: "split",
          model_override: "imported-claude-compact"
        },
        model_map: {
          default: "imported-claude-default",
          opus: "",
          sonnet: "",
          haiku: "",
          reasoning: "",
          subagent: ""
        }
      },
      timeouts: {
        primary_ms: 1000,
        compact_ms: 2000,
        claude_ms: 3000
      },
      logging: {
        redact_body: false,
        keep_recent: 77
      },
      profile_scopes: {
        codex: {
          active_profile_id: "codex-import",
          profiles: [
            {
              id: "codex-import",
              name: "Codex imported",
              created_at: "2026-06-06T00:00:00.000Z",
              updated_at: "2026-06-06T00:00:00.000Z",
              config: {
                primary: { base_url: "http://127.0.0.1:9971/v1", api_key: "profile-primary-key" },
                compact: {
                  base_url: "http://127.0.0.1:9972/v1",
                  model_mode: "custom",
                  model_override: "profile-compact-model"
                }
              }
            }
          ]
        },
        claude: {
          active_profile_id: null,
          profiles: []
        }
      },
      route_url_presets: [
        {
          id: "imported-codex-primary",
          kind: "codex_primary",
          base_url: "http://127.0.0.1:9961/v1",
          host: "127.0.0.1:9961",
          created_at: "2026-06-06T00:00:00.000Z",
          updated_at: "2026-06-06T00:00:00.000Z",
          usage_count: 7
        }
      ]
    });

    expect(imported.primary.base_url).toBe("http://127.0.0.1:9961/v1");
    expect(imported.primary.api_key).toBe("import-primary-key");
    expect(imported.compact.model_override).toBe("imported-compact-model");
    expect(imported.profile_scopes?.codex?.active_profile_id).toBe("codex-import");
    expect(imported.profile_scopes?.codex?.profiles?.[0]?.config).toMatchObject({
      primary: {
        base_url: "http://127.0.0.1:9971/v1",
        api_key: "profile-primary-key"
      },
      compact: {
        base_url: "http://127.0.0.1:9972/v1",
        model_override: "profile-compact-model"
      }
    });
    expect(imported.route_url_presets).toEqual([
      expect.objectContaining({
        kind: "codex_primary",
        base_url: "http://127.0.0.1:9961/v1",
        host: "127.0.0.1:9961",
        usage_count: 7
      })
    ]);

    const publicConfig = store.toPublicConfig();
    expect(JSON.stringify(publicConfig)).not.toContain("import-primary-key");
    expect(JSON.stringify(publicConfig)).not.toContain("profile-primary-key");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      primary: { base_url: "http://127.0.0.1:9961/v1", api_key: "import-primary-key" },
      route_url_presets: [
        {
          kind: "codex_primary",
          base_url: "http://127.0.0.1:9961/v1",
          usage_count: 7
        }
      ]
    });
  });
});
