import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("Claude scene configuration", () => {
  it("round-trips valid scene targets and prevents stale profile references", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const saved = await store.saveProfile("claude", "Scene target", {
      claude: {
        primary: { base_url: "http://127.0.0.1:9301" }
      }
    });
    const profileId = saved.profile_scopes?.claude?.profiles?.[0]?.id;
    expect(profileId).toBeDefined();

    await store.patch({
      claude: {
        long_context_bytes: 4096,
        scene_map: {
          web_search: {
            profile_id: profileId,
            model: "scene-search-model"
          }
        }
      }
    });

    expect(store.get().claude).toMatchObject({
      long_context_bytes: 4096,
      scene_map: {
        web_search: {
          profile_id: profileId,
          model: "scene-search-model"
        }
      }
    });
    expect(store.toPublicConfig().claude.scene_map.web_search.profile_id).toBe(profileId);
    await expect(store.deleteProfile("claude", profileId!)).rejects.toThrow(
      "must reference an existing Claude profile"
    );
    await expect(store.patch({
      claude: {
        scene_map: {
          image: { profile_id: "missing-profile" }
        }
      }
    })).rejects.toThrow("must reference an existing Claude profile");
    await expect(store.patch({
      claude: { long_context_bytes: 104_857_601 }
    })).rejects.toThrow("claude.long_context_bytes must be between 0 and 104857600");
  });

  it("deletes a profile whose only remaining reference is another profile's frozen snapshot", async () => {
    // Each Claude profile freezes a copy of claude.scene_map and only the active
    // one is refreshed from the runtime, so unbinding a scene globally leaves the
    // reference inside every inactive snapshot. There is no UI that reaches those
    // copies, so a surviving reference used to make the target undeletable.
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const claudeProfileId = async (name: string, config: unknown) => {
      const saved = await store.saveProfile("claude", name, config);
      return saved.profile_scopes?.claude?.profiles?.find((profile) => profile.name === name)?.id ?? "";
    };

    const cheapId = await claudeProfileId("Cheap", {
      claude: { primary: { base_url: "http://127.0.0.1:9401" } }
    });
    const mainId = await claudeProfileId("Main", {
      claude: { primary: { base_url: "http://127.0.0.1:9402" } }
    });
    expect(cheapId && mainId).toBeTruthy();

    await store.applyProfile("claude", mainId);
    await store.patch({ claude: { scene_map: { background: { profile_id: cheapId } } } });
    await store.applyProfile("claude", cheapId);
    await store.patch({ claude: { scene_map: { background: { profile_id: "" } } } });

    const frozen = store.get().profile_scopes?.claude?.profiles
      ?.find((profile) => profile.id === mainId)?.config as
      { claude?: { scene_map?: Record<string, { profile_id?: string }> } };
    expect(frozen.claude?.scene_map?.background?.profile_id).toBe(cheapId);

    await store.deleteProfile("claude", cheapId);

    const after = store.get();
    expect(after.profile_scopes?.claude?.profiles?.some((profile) => profile.id === cheapId)).toBe(false);
    const cleaned = after.profile_scopes?.claude?.profiles
      ?.find((profile) => profile.id === mainId)?.config as
      { claude?: { scene_map?: Record<string, { profile_id?: string }> } };
    expect(cleaned.claude?.scene_map?.background?.profile_id).toBe("");
  });
});
