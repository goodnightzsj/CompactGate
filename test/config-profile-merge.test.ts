import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { createProfileId } from "../src/server/config-profile-scope.js";
import { statusForError } from "../src/server/http-utils.js";
import { ConfigError } from "../src/server/config-internals.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const LEGACY_CONFIG = {
  listen: "127.0.0.1:7865",
  // A real legacy file also persists the runtime, which mirrors whichever profile
  // was active when it was written.
  primary: { base_url: "http://127.0.0.1:8101/v1", api_key: "legacy-primary-key" },
  compact: { base_url: "http://127.0.0.1:8102/v1", api_key: "legacy-compact-key" },
  active_profile_id: "legacy-codex",
  profiles: [
    {
      id: "legacy-codex",
      name: "Legacy codex",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      config: {
        primary: { base_url: "http://127.0.0.1:8101/v1", api_key: "legacy-primary-key" },
        compact: { base_url: "http://127.0.0.1:8102/v1", api_key: "legacy-compact-key" }
      }
    },
    {
      id: "legacy-claude",
      name: "Legacy claude",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      config: {
        claude: {
          primary: { base_url: "http://127.0.0.1:8103", api_key: "legacy-claude-key" },
          compact: { base_url: "http://127.0.0.1:8104" }
        }
      }
    }
  ]
};

describe("legacy top-level profiles", () => {
  it("migrates a config file that has no profile_scopes", async () => {
    const dir = await makeConfigDir();
    const configPath = path.join(dir, "compactgate.json");
    await writeFile(configPath, JSON.stringify(LEGACY_CONFIG), "utf8");

    const store = await ConfigStore.load(configPath);
    const loaded = store.get();

    expect(loaded.profile_scopes?.codex?.profiles?.map((profile) => profile.id)).toEqual(["legacy-codex"]);
    expect(loaded.profile_scopes?.codex?.active_profile_id).toBe("legacy-codex");
    expect(loaded.profile_scopes?.codex?.profiles?.[0]?.config).toMatchObject({
      primary: { base_url: "http://127.0.0.1:8101/v1", api_key: "legacy-primary-key" },
      compact: { base_url: "http://127.0.0.1:8102/v1", api_key: "legacy-compact-key" }
    });

    // A profile whose stored config only has the claude section belongs to the
    // claude scope; read as codex it would keep nothing but its name.
    expect(loaded.profile_scopes?.claude?.profiles?.map((profile) => profile.id)).toEqual(["legacy-claude"]);
    expect(loaded.profile_scopes?.claude?.profiles?.[0]?.config).toMatchObject({
      claude: {
        primary: { base_url: "http://127.0.0.1:8103", api_key: "legacy-claude-key" },
        compact: { base_url: "http://127.0.0.1:8104" }
      }
    });
    expect(loaded.profile_scopes?.claude?.active_profile_id).toBeNull();
  });

  it("keeps the migrated profiles through the next write", async () => {
    const dir = await makeConfigDir();
    const configPath = path.join(dir, "compactgate.json");
    await writeFile(configPath, JSON.stringify(LEGACY_CONFIG), "utf8");

    const store = await ConfigStore.load(configPath);
    const patched = await store.patch({ logging: { keep_recent: 123 } });

    expect(patched.profile_scopes?.codex?.profiles?.[0]?.config).toMatchObject({
      primary: { base_url: "http://127.0.0.1:8101/v1", api_key: "legacy-primary-key" }
    });
    expect(patched.profile_scopes?.claude?.profiles?.[0]?.config).toMatchObject({
      claude: { primary: { base_url: "http://127.0.0.1:8103", api_key: "legacy-claude-key" } }
    });
    expect(patched.primary.api_key).toBe("legacy-primary-key");
  });

  it("migrates them even when an empty profile_scopes sits alongside", async () => {
    // A hand-edited file, or an export from the transition, carries both shapes.
    // An explicitly present but empty scope list was treated as authoritative and
    // erased everything the migration had just recovered, and the next write
    // persisted the emptied file — the exact loss the migration exists to prevent.
    const dir = await makeConfigDir();
    const configPath = path.join(dir, "compactgate.json");
    await writeFile(configPath, JSON.stringify({
      ...LEGACY_CONFIG,
      profile_scopes: {
        codex: { profiles: [], active_profile_id: null },
        claude: { profiles: [], active_profile_id: null }
      }
    }), "utf8");

    const store = await ConfigStore.load(configPath);
    expect(store.get().profile_scopes?.codex?.profiles?.map((profile) => profile.id)).toEqual(["legacy-codex"]);
    expect(store.get().profile_scopes?.claude?.profiles?.map((profile) => profile.id)).toEqual(["legacy-claude"]);

    // And they survive the write that follows, credentials included.
    const patched = await store.patch({ logging: { keep_recent: 123 } });
    expect(patched.profile_scopes?.codex?.profiles?.[0]?.config).toMatchObject({
      primary: { api_key: "legacy-primary-key" }
    });
  });

  it("migrates an imported legacy export", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    const imported = await store.importConfig(LEGACY_CONFIG);

    expect(imported.profile_scopes?.codex?.profiles?.map((profile) => profile.name)).toEqual(["Legacy codex"]);
    expect(imported.profile_scopes?.claude?.profiles?.map((profile) => profile.name)).toEqual(["Legacy claude"]);
    expect(imported.profile_scopes?.codex?.active_profile_id).toBe("legacy-codex");
  });

  it("does not resurrect legacy profiles over stored profile_scopes", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const saved = await store.saveProfile("codex", "Stored", {
      primary: { base_url: "http://127.0.0.1:8201/v1" }
    });
    const storedId = saved.profile_scopes?.codex?.profiles?.[0]?.id ?? "";

    const patched = await store.patch(LEGACY_CONFIG);

    expect(patched.profile_scopes?.codex?.profiles?.map((profile) => profile.id)).toEqual([storedId]);
  });
});

describe("profiles restated in a patch", () => {
  it("keeps the stored config of a profile restated without one", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const saved = await store.saveProfile("codex", "Restated", {
      primary: {
        base_url: "http://127.0.0.1:8301/v1",
        api_key: "restated-primary-key",
        state_domain_id: "restated-domain"
      },
      compact: {
        base_url: "http://127.0.0.1:8302/v1",
        api_key: "restated-compact-key",
        upstream_mode: "primary"
      }
    });
    const profile = saved.profile_scopes?.codex?.profiles?.[0];
    expect(profile).toBeTruthy();

    // What a script gets back from GET /api/config: PublicConfigProfile has no
    // `config` field at all.
    const patched = await store.patch({
      logging: { keep_recent: 250 },
      profile_scopes: {
        codex: {
          active_profile_id: null,
          profiles: [
            {
              id: profile?.id,
              scope: "codex",
              name: profile?.name,
              created_at: profile?.created_at,
              updated_at: profile?.updated_at,
              primary_base_url: "http://127.0.0.1:8301/v1"
            }
          ]
        }
      }
    });

    expect(patched.logging.keep_recent).toBe(250);
    expect(patched.profile_scopes?.codex?.profiles?.[0]).toMatchObject({
      id: profile?.id,
      name: "Restated",
      created_at: profile?.created_at,
      config: {
        primary: {
          base_url: "http://127.0.0.1:8301/v1",
          api_key: "restated-primary-key",
          state_domain_id: "restated-domain"
        },
        compact: {
          base_url: "http://127.0.0.1:8302/v1",
          api_key: "restated-compact-key",
          upstream_mode: "primary"
        }
      }
    });
  });

  it("still replaces the list outright on import", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    await store.saveProfile("codex", "Before import", {
      primary: { base_url: "http://127.0.0.1:8401/v1", api_key: "before-import-key" }
    });

    const imported = await store.importConfig({
      profile_scopes: {
        codex: {
          active_profile_id: null,
          profiles: [
            {
              id: "after-import",
              name: "After import",
              config: { primary: { base_url: "http://127.0.0.1:8402/v1" } }
            }
          ]
        }
      }
    });

    expect(imported.profile_scopes?.codex?.profiles?.map((profile) => profile.id)).toEqual(["after-import"]);
    expect(JSON.stringify(imported.profile_scopes)).not.toContain("before-import-key");
  });
});

describe("patching active_profile_id", () => {
  it("applies the target profile instead of overwriting it", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const a = await store.saveProfile("codex", "A", {
      primary: { base_url: "http://127.0.0.1:8501/v1", api_key: "a-key" },
      compact: { base_url: "http://127.0.0.1:8502/v1" }
    });
    const aId = a.profile_scopes?.codex?.profiles?.[0]?.id ?? "";
    const b = await store.saveProfile("codex", "B", {
      primary: { base_url: "http://127.0.0.1:8511/v1", api_key: "b-key" },
      compact: { base_url: "http://127.0.0.1:8512/v1" }
    });
    const bId = b.profile_scopes?.codex?.profiles?.find((profile) => profile.name === "B")?.id ?? "";
    await store.applyProfile("codex", aId);

    const switched = await store.patch({
      profile_scopes: { codex: { active_profile_id: bId } }
    });

    expect(switched.profile_scopes?.codex?.active_profile_id).toBe(bId);
    expect(switched.primary.base_url).toBe("http://127.0.0.1:8511/v1");
    expect(switched.primary.api_key).toBe("b-key");
    const storedB = switched.profile_scopes?.codex?.profiles?.find((profile) => profile.id === bId);
    expect(storedB?.config).toMatchObject({
      primary: { base_url: "http://127.0.0.1:8511/v1", api_key: "b-key" }
    });
    const storedA = switched.profile_scopes?.codex?.profiles?.find((profile) => profile.id === aId);
    expect(storedA?.config).toMatchObject({
      primary: { base_url: "http://127.0.0.1:8501/v1", api_key: "a-key" }
    });
  });

  it("still mirrors a runtime-only patch into the active profile", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const saved = await store.saveProfile("codex", "Mirror", {
      primary: { base_url: "http://127.0.0.1:8601/v1", api_key: "mirror-key" }
    });
    const profileId = saved.profile_scopes?.codex?.profiles?.[0]?.id ?? "";
    await store.applyProfile("codex", profileId);

    const patched = await store.patch({ primary: { base_url: "http://127.0.0.1:8602/v1" } });

    expect(patched.profile_scopes?.codex?.profiles?.[0]?.config).toMatchObject({
      primary: { base_url: "http://127.0.0.1:8602/v1", api_key: "mirror-key" }
    });
  });

  it("leaves updated_at alone when the patch does not touch the profile config", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const saved = await store.saveProfile("codex", "Timestamp", {
      primary: { base_url: "http://127.0.0.1:8701/v1" }
    });
    const profileId = saved.profile_scopes?.codex?.profiles?.[0]?.id ?? "";
    await store.applyProfile("codex", profileId);
    const before = store.get().profile_scopes?.codex?.profiles?.[0]?.updated_at;

    const unrelated = await store.patch({ logging: { keep_recent: 321 } });
    expect(unrelated.profile_scopes?.codex?.profiles?.[0]?.updated_at).toBe(before);

    const edited = await store.patch({ primary: { base_url: "http://127.0.0.1:8702/v1" } });
    expect(edited.profile_scopes?.codex?.profiles?.[0]?.updated_at).not.toBe(before);
  });
});

describe("import validation", () => {
  it("rejects a profile without an id instead of dropping it", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await expect(store.importConfig({
      profile_scopes: {
        codex: { profiles: [{ name: "No id", config: {} }] }
      }
    })).rejects.toThrow(/profile\.id is required/);
  });

  it("rejects a URL preset with an invalid base_url instead of dropping it", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await expect(store.importConfig({
      route_url_presets: [{ kind: "codex_primary", base_url: "not-a-url" }]
    })).rejects.toThrow(/route_url_presets\.codex_primary\.base_url/);
  });

  it("still tolerates junk entries on the patch path", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    const patched = await store.patch({
      profile_scopes: { codex: { profiles: [{ name: "No id" }] } },
      route_url_presets: [{ kind: "codex_primary", base_url: "not-a-url" }]
    });

    expect(patched.profile_scopes?.codex?.profiles).toEqual([]);
    expect(JSON.stringify(patched.route_url_presets)).not.toContain("not-a-url");
  });
});

describe("config error statuses", () => {
  it("maps a revision conflict to 409 and keeps the message clients match", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const stale = store.toPublicConfig().revision;
    await store.patch({ logging: { keep_recent: 400 } });

    const error = await store.patch({ revision: stale, logging: { keep_recent: 401 } })
      .then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toMatch(/superseded revision/i);
    expect(statusForError(error)).toBe(409);
  });

  it("maps a missing profile to 404 and other config errors to 400", () => {
    // The status travels with the error rather than being recovered by matching
    // its English text, so the one throw site (`requireProfile`) owns it and a
    // reworded message cannot silently demote the route back to 400.
    expect(statusForError(new ConfigError("Profile not found.", 404))).toBe(404);
    expect(statusForError(new ConfigError("Profile name is required."))).toBe(400);
  });
});

describe("claude compact upstream_mode validation", () => {
  it("names the claude route in the error", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await expect(store.patch({
      claude: { compact: { upstream_mode: "nonsense" } }
    })).rejects.toThrow("claude.compact.upstream_mode must be split or primary.");
    await expect(store.patch({
      compact: { upstream_mode: "nonsense" }
    })).rejects.toThrow("compact.upstream_mode must be split or primary.");
  });
});

describe("createProfileId", () => {
  it("separates names that share the first 40 slug characters", () => {
    const now = "2026-06-09T00:00:00.000Z";
    const left = `${"codex-a-very-long-profile-name-that-runs-on"} one`;
    const right = `${"codex-a-very-long-profile-name-that-runs-on"} two`;

    expect(createProfileId(left, now)).not.toBe(createProfileId(right, now));
    expect(createProfileId(left, now)).toBe(createProfileId(left, now));
  });
});
