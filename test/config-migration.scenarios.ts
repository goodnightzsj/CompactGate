import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("ConfigStore", () => {
  it("migrates legacy combined profiles into scoped fragments and dedupes Claude profiles", async () => {
    const dir = await makeConfigDir();

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
