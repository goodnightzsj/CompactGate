import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("ConfigStore", () => {
  it("saves and applies named config profiles without exposing stored API keys", async () => {
    const dir = await makeConfigDir();

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
    expect(saved.route_url_presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "codex_primary", base_url: "http://127.0.0.1:9201/v1" }),
        expect.objectContaining({ kind: "codex_compact", base_url: "http://127.0.0.1:9202/v1" })
      ])
    );
    expect(JSON.stringify(saved.route_url_presets)).not.toContain("profile-compact-key");

    const publicConfig = store.toPublicConfig();
    expect(publicConfig.profiles).toHaveLength(1);
    expect(publicConfig.profiles[0]).toMatchObject({
      id: profileId,
      scope: "codex",
      name: "Local split",
      primary_base_url: "http://127.0.0.1:9201/v1",
      compact_base_url: "http://127.0.0.1:9202/v1",
      claude_primary_base_url: null,
      claude_compact_base_url: null,
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
    expect(applied.route_url_presets).toEqual(saved.route_url_presets);

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
    const dir = await makeConfigDir();

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
    expect(saved.route_url_presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "codex_primary", base_url: "http://127.0.0.1:9501/v1" }),
        expect.objectContaining({ kind: "codex_compact", base_url: "http://127.0.0.1:9502/v1" }),
        expect.objectContaining({ kind: "claude_primary", base_url: "http://127.0.0.1:9503" }),
        expect.objectContaining({ kind: "claude_compact", base_url: "http://127.0.0.1:9504" })
      ])
    );
    expect(store.toPublicConfig().profile_scopes.claude.profiles[0]).toMatchObject({
      primary_base_url: null,
      compact_base_url: null,
      claude_primary_base_url: "http://127.0.0.1:9503",
      claude_compact_base_url: "http://127.0.0.1:9504",
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

  it("serializes concurrent config mutations before persisting", async () => {
    const dir = await makeConfigDir();

    const configPath = path.join(dir, "compactgate.json");
    const store = await ConfigStore.load(configPath);
    await Promise.all([
      store.patch({
        primary: { base_url: "http://127.0.0.1:9561/v1" }
      }),
      store.saveProfile("codex", "Concurrent Codex", {
        primary: { base_url: "http://127.0.0.1:9562/v1" },
        compact: { base_url: "http://127.0.0.1:9563/v1" }
      }),
      store.saveProfile("claude", "Concurrent Claude", {
        claude: {
          primary: { base_url: "http://127.0.0.1:9564" },
          compact: { base_url: "http://127.0.0.1:9565", upstream_mode: "split" }
        }
      })
    ]);

    const inMemory = store.get();
    const persisted = JSON.parse(await readFile(configPath, "utf8")) as typeof inMemory;
    expect(inMemory.primary.base_url).toBe("http://127.0.0.1:9561/v1");
    expect(inMemory.profile_scopes?.codex?.profiles?.map((profile) => profile.name)).toContain("Concurrent Codex");
    expect(inMemory.profile_scopes?.claude?.profiles?.map((profile) => profile.name)).toContain("Concurrent Claude");
    expect(persisted).toMatchObject(inMemory);
    expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("reorders scoped config profiles without mutating profile content", async () => {
    const dir = await makeConfigDir();

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
});
