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
});
