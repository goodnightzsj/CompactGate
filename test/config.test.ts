import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("loads legacy single Claude config as both Claude primary and compact routes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

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
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

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

  it("saves and applies named config profiles without exposing stored API keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

    const configPath = path.join(dir, "compactgate.json");
    const store = await ConfigStore.load(configPath);
    await store.patch({
      primary: {
        base_url: "http://127.0.0.1:9101/v1",
        api_key: "active-primary-key"
      },
      compact: {
        base_url: "http://127.0.0.1:9102/v1",
        api_key: "active-compact-key",
        model_mode: "custom",
        model_override: "active-compact-model"
      }
    });

    const saved = await store.saveProfile("Local split", {
      primary: {
        base_url: "http://127.0.0.1:9201/v1",
        api_key: "profile-primary-key"
      },
      compact: {
        base_url: "http://127.0.0.1:9202/v1",
        api_key: "profile-compact-key",
        upstream_mode: "split",
        model_mode: "custom",
        model_override: "profile-compact-model"
      },
      claude: {
        primary: {
          base_url: "http://127.0.0.1:9203",
          api_key: "profile-claude-primary-key"
        },
        compact: {
          base_url: "http://127.0.0.1:9204",
          api_key: "profile-claude-compact-key"
        }
      }
    });
    const profileId = saved.profile_scopes?.codex?.profiles?.[0]?.id;
    expect(profileId).toBeTruthy();

    const publicConfig = store.toPublicConfig();
    expect(publicConfig.profiles).toHaveLength(1);
    expect(publicConfig.profiles[0]).toMatchObject({
      id: profileId,
      scope: "codex",
      name: "Local split",
      primary_host: "127.0.0.1:9201",
      compact_host: "127.0.0.1:9202",
      claude_primary_host: null,
      claude_compact_host: null,
      compact_upstream_mode: "split",
      claude_compact_upstream_mode: null,
      stored_api_key_count: 2
    });
    expect(JSON.stringify(publicConfig)).not.toContain("profile-primary-key");
    expect(JSON.stringify(publicConfig)).not.toContain("profile-claude-compact-key");

    await store.applyProfile(profileId ?? "");
    const applied = store.get();
    expect(applied.profile_scopes?.codex?.active_profile_id).toBe(profileId);
    expect(applied.primary.base_url).toBe("http://127.0.0.1:9201/v1");
    expect(applied.primary.api_key).toBe("profile-primary-key");
    expect(applied.compact.model_override).toBe("profile-compact-model");
    expect(applied.claude.compact.base_url).toBe("https://api.anthropic.com");

    await store.patch({
      primary: {
        base_url: "http://127.0.0.1:9301/v1"
      }
    });
    const patched = store.get();
    expect(patched.active_profile_id).toBe(profileId);
    expect(patched.profile_scopes?.codex?.active_profile_id).toBe(profileId);
    expect(patched.profile_scopes?.codex?.profiles).toHaveLength(1);
    const patchedCodexConfig = patched.profile_scopes?.codex?.profiles?.[0]?.config;
    expect(patchedCodexConfig).toMatchObject({
      primary: {
        base_url: "http://127.0.0.1:9301/v1",
        api_key: "profile-primary-key"
      },
      compact: { api_key: "profile-compact-key" }
    });
    expect(patchedCodexConfig).not.toHaveProperty("claude");

    const duplicated = await store.duplicateProfile(profileId ?? "", "Local split copy");
    const duplicateId = duplicated.profile_scopes?.codex?.profiles?.find((profile) => profile.name === "Local split copy")?.id;
    expect(duplicateId).toBeTruthy();
    expect(duplicateId).not.toBe(profileId);
    expect(duplicated.profile_scopes?.codex?.profiles).toHaveLength(2);

    await store.updateProfile(profileId ?? "", "Local split updated", {
      primary: {
        base_url: "http://127.0.0.1:9401/v1"
      },
      compact: {
        model_override: "updated-profile-compact-model"
      }
    });
    const updated = store.get();
    const updatedProfile = updated.profile_scopes?.codex?.profiles?.find((profile) => profile.id === profileId);
    expect(updatedProfile?.name).toBe("Local split updated");
    expect(updatedProfile?.config).toMatchObject({
      primary: {
        base_url: "http://127.0.0.1:9401/v1",
        api_key: "profile-primary-key"
      },
      compact: {
        model_override: "updated-profile-compact-model"
      }
    });
    expect(updatedProfile?.config).not.toHaveProperty("claude");

    await store.deleteProfile(profileId ?? "");
    const deleted = store.get();
    expect(deleted.profile_scopes?.codex?.profiles).toHaveLength(1);
    expect(deleted.profile_scopes?.codex?.profiles?.[0]?.id).toBe(duplicateId);
    expect(deleted.profile_scopes?.codex?.active_profile_id).toBeNull();
    expect(JSON.stringify(store.toPublicConfig())).not.toContain("profile-primary-key");
  });

  it("keeps Codex and Claude config profiles independent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    await store.saveProfile("codex", "Codex only", {
      primary: { base_url: "http://127.0.0.1:9501/v1" },
      compact: { base_url: "http://127.0.0.1:9502/v1" }
    });
    await store.saveProfile("claude", "Claude only", {
      claude: {
        primary: {
          base_url: "http://127.0.0.1:9503",
          model_override: "claude-profile-primary-model"
        },
        compact: {
          base_url: "http://127.0.0.1:9504",
          upstream_mode: "split",
          model_override: "claude-profile-compact-model"
        }
      }
    });

    const saved = store.get();
    const codexId = saved.profile_scopes?.codex?.profiles?.[0]?.id ?? "";
    const claudeId = saved.profile_scopes?.claude?.profiles?.[0]?.id ?? "";
    expect(codexId).toBeTruthy();
    expect(claudeId).toBeTruthy();
    expect(saved.profile_scopes?.codex?.profiles?.[0]?.config).toMatchObject({
      primary: { base_url: "http://127.0.0.1:9501/v1" },
      compact: { base_url: "http://127.0.0.1:9502/v1" }
    });
    expect(saved.profile_scopes?.codex?.profiles?.[0]?.config).not.toHaveProperty("claude");
    expect(saved.profile_scopes?.claude?.profiles?.[0]?.config).toMatchObject({
      claude: {
        primary: {
          base_url: "http://127.0.0.1:9503",
          model_override: "claude-profile-primary-model"
        },
        compact: {
          base_url: "http://127.0.0.1:9504",
          model_override: "claude-profile-compact-model"
        }
      }
    });
    expect(store.toPublicConfig().profile_scopes.claude.profiles[0]).toMatchObject({
      claude_primary_model_override: "claude-profile-primary-model",
      claude_compact_model_override: "claude-profile-compact-model"
    });
    expect(saved.profile_scopes?.claude?.profiles?.[0]?.config).not.toHaveProperty("primary");
    expect(saved.profile_scopes?.claude?.profiles?.[0]?.config).not.toHaveProperty("compact");

    await store.applyProfile("codex", codexId);
    let applied = store.get();
    expect(applied.primary.base_url).toBe("http://127.0.0.1:9501/v1");
    expect(applied.compact.base_url).toBe("http://127.0.0.1:9502/v1");
    expect(applied.claude.primary.base_url).toBe("https://api.anthropic.com");
    expect(applied.profile_scopes?.codex?.active_profile_id).toBe(codexId);
    expect(applied.profile_scopes?.claude?.active_profile_id).toBeNull();

    await store.applyProfile("claude", claudeId);
    applied = store.get();
    expect(applied.primary.base_url).toBe("http://127.0.0.1:9501/v1");
    expect(applied.claude.primary.base_url).toBe("http://127.0.0.1:9503");
    expect(applied.claude.primary.model_override).toBe("claude-profile-primary-model");
    expect(applied.claude.compact.base_url).toBe("http://127.0.0.1:9504");
    expect(applied.claude.compact.model_override).toBe("claude-profile-compact-model");
    expect(applied.profile_scopes?.codex?.active_profile_id).toBe(codexId);
    expect(applied.profile_scopes?.claude?.active_profile_id).toBe(claudeId);
  });

  it("reorders scoped config profiles without mutating profile content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

    const configPath = path.join(dir, "compactgate.json");
    const store = await ConfigStore.load(configPath);
    await store.saveProfile("codex", "Codex first", {
      primary: { base_url: "http://127.0.0.1:9521/v1", api_key: "codex-first-key" },
      compact: { base_url: "http://127.0.0.1:9522/v1" }
    });
    await store.saveProfile("codex", "Codex second", {
      primary: { base_url: "http://127.0.0.1:9531/v1" },
      compact: { base_url: "http://127.0.0.1:9532/v1" }
    });
    await store.saveProfile("codex", "Codex third", {
      primary: { base_url: "http://127.0.0.1:9541/v1" },
      compact: { base_url: "http://127.0.0.1:9542/v1" }
    });
    await store.saveProfile("claude", "Claude first", {
      claude: {
        primary: { base_url: "http://127.0.0.1:9551", api_key: "claude-first-key" },
        compact: { base_url: "http://127.0.0.1:9552" }
      }
    });

    const before = store.get();
    const codexProfiles = before.profile_scopes?.codex?.profiles ?? [];
    const claudeProfiles = before.profile_scopes?.claude?.profiles ?? [];
    const codexFirstId = codexProfiles.find((profile) => profile.name === "Codex first")?.id ?? "";
    const codexSecondId = codexProfiles.find((profile) => profile.name === "Codex second")?.id ?? "";
    const codexThirdId = codexProfiles.find((profile) => profile.name === "Codex third")?.id ?? "";
    const claudeFirstId = claudeProfiles.find((profile) => profile.name === "Claude first")?.id ?? "";
    const codexFirstUpdatedAt = codexProfiles.find((profile) => profile.id === codexFirstId)?.updated_at;
    expect(codexFirstId).toBeTruthy();
    expect(codexSecondId).toBeTruthy();
    expect(codexThirdId).toBeTruthy();
    expect(claudeFirstId).toBeTruthy();

    await store.applyProfile("codex", codexSecondId);
    const reordered = await store.reorderProfiles("codex", [codexThirdId, codexFirstId, codexSecondId]);

    expect(reordered.profile_scopes?.codex?.profiles?.map((profile) => profile.id)).toEqual([
      codexThirdId,
      codexFirstId,
      codexSecondId
    ]);
    expect(reordered.profile_scopes?.codex?.active_profile_id).toBe(codexSecondId);
    expect(reordered.profile_scopes?.claude?.profiles?.map((profile) => profile.id)).toEqual([claudeFirstId]);
    expect(
      reordered.profile_scopes?.codex?.profiles?.find((profile) => profile.id === codexFirstId)?.updated_at
    ).toBe(codexFirstUpdatedAt);
    expect(JSON.stringify(store.toPublicConfig())).not.toContain("codex-first-key");
    expect(JSON.stringify(store.toPublicConfig())).not.toContain("claude-first-key");

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.profile_scopes.codex.profiles.map((profile: { id: string }) => profile.id)).toEqual([
      codexThirdId,
      codexFirstId,
      codexSecondId
    ]);

    await expect(store.reorderProfiles("codex", [codexFirstId, codexFirstId, codexSecondId])).rejects.toThrow(
      /unique/
    );
    await expect(store.reorderProfiles("codex", [codexFirstId, codexSecondId])).rejects.toThrow(/every profile/);
    await expect(store.reorderProfiles("codex", [claudeFirstId, codexFirstId, codexSecondId])).rejects.toThrow(
      /existing profiles/
    );
  });

  it("syncs runtime config when updating active scoped profiles", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

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

  it("migrates legacy combined profiles into scoped fragments and dedupes Claude profiles", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
    cleanupPaths.push(dir);

    const configPath = path.join(dir, "compactgate.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          profiles: [
            {
              id: "one",
              name: "One",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              config: {
                primary: { base_url: "http://127.0.0.1:9601/v1" },
                compact: { base_url: "http://127.0.0.1:9602/v1" },
                claude: {
                  primary: { base_url: "http://127.0.0.1:9603" },
                  compact: { base_url: "http://127.0.0.1:9604", upstream_mode: "split" }
                }
              }
            },
            {
              id: "two",
              name: "Two",
              created_at: "2026-01-02T00:00:00.000Z",
              updated_at: "2026-01-02T00:00:00.000Z",
              config: {
                primary: { base_url: "http://127.0.0.1:9701/v1" },
                compact: { base_url: "http://127.0.0.1:9702/v1" },
                claude: {
                  primary: { base_url: "http://127.0.0.1:9603" },
                  compact: { base_url: "http://127.0.0.1:9604", upstream_mode: "split" }
                }
              }
            }
          ],
          active_profile_id: "two"
        },
        null,
        2
      )
    );

    const store = await ConfigStore.load(configPath);
    const migrated = store.get();

    expect(migrated.profile_scopes?.codex?.profiles).toHaveLength(2);
    expect(migrated.profile_scopes?.claude?.profiles).toHaveLength(1);
    expect(migrated.profile_scopes?.codex?.active_profile_id).toBe("two");
    expect(migrated.profile_scopes?.claude?.active_profile_id).toBe("one");
    expect(migrated.profile_scopes?.codex?.profiles?.[0]?.config).not.toHaveProperty("claude");
    expect(migrated.profile_scopes?.claude?.profiles?.[0]?.config).not.toHaveProperty("primary");
    expect(migrated.profile_scopes?.claude?.profiles?.[0]?.config).not.toHaveProperty("compact");
    expect(migrated.profile_scopes?.claude?.profiles?.[0]?.config).toMatchObject({
      claude: {
        primary: { base_url: "http://127.0.0.1:9603" },
        compact: { base_url: "http://127.0.0.1:9604", upstream_mode: "split" }
      }
    });
  });

});
