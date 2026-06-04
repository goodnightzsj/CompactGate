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
      api_key_env: "LEGACY_CLAUDE_KEY"
    });
    expect(config.claude.compact).toEqual({
      ...config.claude.primary,
      upstream_mode: "primary",
      model_override: ""
    });
    expect(publicConfig.claude.primary.base_url).toBe("http://127.0.0.1:9010");
    expect(publicConfig.claude.compact.base_url).toBe("http://127.0.0.1:9010");
    expect(publicConfig.claude.compact.upstream_mode).toBe("primary");
    expect(publicConfig.claude.compact.model_override).toBe("");
    expect(publicConfig.claude.primary.stored_api_key).toBe(true);
    expect(publicConfig.claude.compact.stored_api_key).toBe(true);
    expect(JSON.stringify(publicConfig)).not.toContain("legacy-claude-key");
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
    const profileId = saved.profiles?.[0]?.id;
    expect(profileId).toBeTruthy();

    const publicConfig = store.toPublicConfig();
    expect(publicConfig.profiles).toHaveLength(1);
    expect(publicConfig.profiles[0]).toMatchObject({
      id: profileId,
      name: "Local split",
      primary_host: "127.0.0.1:9201",
      compact_host: "127.0.0.1:9202",
      claude_primary_host: "127.0.0.1:9203",
      claude_compact_host: "127.0.0.1:9204",
      compact_upstream_mode: "split",
      claude_compact_upstream_mode: "primary",
      stored_api_key_count: 4
    });
    expect(JSON.stringify(publicConfig)).not.toContain("profile-primary-key");
    expect(JSON.stringify(publicConfig)).not.toContain("profile-claude-compact-key");

    await store.applyProfile(profileId ?? "");
    const applied = store.get();
    expect(applied.active_profile_id).toBe(profileId);
    expect(applied.primary.base_url).toBe("http://127.0.0.1:9201/v1");
    expect(applied.primary.api_key).toBe("profile-primary-key");
    expect(applied.compact.model_override).toBe("profile-compact-model");
    expect(applied.claude.compact.base_url).toBe("http://127.0.0.1:9204");

    await store.patch({
      primary: {
        base_url: "http://127.0.0.1:9301/v1"
      }
    });
    const patched = store.get();
    expect(patched.active_profile_id).toBeNull();
    expect(patched.profiles).toHaveLength(1);
    expect(patched.profiles?.[0]?.config.primary.api_key).toBe("profile-primary-key");

    const duplicated = await store.duplicateProfile(profileId ?? "", "Local split copy");
    const duplicateId = duplicated.profiles?.find((profile) => profile.name === "Local split copy")?.id;
    expect(duplicateId).toBeTruthy();
    expect(duplicateId).not.toBe(profileId);
    expect(duplicated.profiles).toHaveLength(2);

    await store.updateProfile(profileId ?? "", "Local split updated", {
      primary: {
        base_url: "http://127.0.0.1:9401/v1"
      },
      compact: {
        model_override: "updated-profile-compact-model"
      }
    });
    const updated = store.get();
    const updatedProfile = updated.profiles?.find((profile) => profile.id === profileId);
    expect(updatedProfile?.name).toBe("Local split updated");
    expect(updatedProfile?.config.primary.base_url).toBe("http://127.0.0.1:9401/v1");
    expect(updatedProfile?.config.primary.api_key).toBe("profile-primary-key");
    expect(updatedProfile?.config.compact.model_override).toBe("updated-profile-compact-model");

    await store.deleteProfile(profileId ?? "");
    const deleted = store.get();
    expect(deleted.profiles).toHaveLength(1);
    expect(deleted.profiles?.[0]?.id).toBe(duplicateId);
    expect(deleted.active_profile_id).toBeNull();
    expect(JSON.stringify(store.toPublicConfig())).not.toContain("profile-primary-key");
  });
});
