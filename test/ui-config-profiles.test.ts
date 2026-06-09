import { describe, expect, it } from "vitest";
import { nextDuplicateProfileName } from "../src/ui/hooks/configProfileCollectionActions.js";
import type { PublicConfig } from "../src/shared/types.js";

describe("UI config profile actions", () => {
  it("generates a copy name instead of reusing the selected profile name", () => {
    expect(nextDuplicateProfileName({
      profiles: [profile("Local split")],
      selectedName: "Local split",
      sourceName: "Local split"
    })).toBe("Local split copy");
  });

  it("increments generated copy names that already exist", () => {
    expect(nextDuplicateProfileName({
      profiles: [
        profile("Local split"),
        profile("Local split copy"),
        profile("Local split copy 2")
      ],
      selectedName: "Local split",
      sourceName: "Local split"
    })).toBe("Local split copy 3");
  });

  it("keeps a manually edited duplicate name", () => {
    expect(nextDuplicateProfileName({
      profiles: [profile("Local split")],
      selectedName: "Manual copy",
      sourceName: "Local split"
    })).toBe("Manual copy");
  });
});

function profile(name: string): PublicConfig["profiles"][number] {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    scope: "codex",
    name,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    primary_base_url: "http://127.0.0.1:9101/v1",
    compact_base_url: "http://127.0.0.1:9102/v1",
    claude_primary_base_url: null,
    claude_compact_base_url: null,
    primary_host: "127.0.0.1:9101",
    compact_host: "127.0.0.1:9102",
    claude_primary_host: null,
    claude_compact_host: null,
    claude_primary_model_override: null,
    claude_compact_model_override: null,
    claude_model_map: null,
    compact_upstream_mode: "split",
    claude_compact_upstream_mode: null,
    stored_api_key_count: 0
  };
}
