import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileScopeCard } from "../src/ui/config/ProfileScopeCard.js";
import { nextDuplicateProfileName } from "../src/ui/hooks/configProfileCollectionActions.js";
import { nextProfileNameSyncState } from "../src/ui/hooks/useScopedProfileControls.js";
import { profileSummary } from "../src/ui/config/profile-utils.js";
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

  it("syncs a selected profile name after external config updates", () => {
    expect(nextProfileNameSyncState({
      profiles: [profile("Renamed remote", "local-split")],
      activeProfileId: null,
      selectedId: "local-split",
      name: "Local split",
      sourceProfileId: "local-split",
      dirty: false
    })).toMatchObject({
      selectedId: "local-split",
      name: "Renamed remote",
      sourceProfileId: "local-split",
      dirty: false
    });
  });

  it("does not overwrite an in-progress local profile name draft", () => {
    expect(nextProfileNameSyncState({
      profiles: [profile("Local split remote")],
      activeProfileId: null,
      selectedId: "local-split-remote",
      name: "Manual local draft",
      sourceProfileId: "local-split-remote",
      dirty: true
    })).toMatchObject({
      selectedId: "local-split-remote",
      name: "Manual local draft",
      dirty: true
    });
  });

  it("falls back when the selected profile disappears", () => {
    expect(nextProfileNameSyncState({
      profiles: [profile("Fallback")],
      activeProfileId: "fallback",
      selectedId: "deleted",
      name: "Deleted",
      sourceProfileId: "deleted",
      dirty: false
    })).toMatchObject({
      selectedId: "fallback",
      name: "Fallback",
      sourceProfileId: "fallback",
      dirty: false
    });
  });

  it("includes saved upstream protocols in profile summaries", () => {
    expect(profileSummary(profile("Local split"))).toContain("主 OpenAI Responses");
    expect(profileSummary(profile("Local split"))).toContain("压缩 OpenAI Responses");
  });

  it("offers to rename the selected active profile instead of creating a new one", () => {
    const current = profile("zzzcoding", "current");
    const config = {
      profile_scopes: {
        codex: { profiles: [current], active_profile_id: current.id },
        claude: { profiles: [], active_profile_id: null }
      }
    } as unknown as PublicConfig;
    const markup = renderToStaticMarkup(createElement(ProfileScopeCard, {
      scope: "codex",
      title: "Codex 配置档案",
      eyebrow: "Codex",
      description: "",
      emptyTitle: "",
      emptyDescription: "",
      config,
      profileName: "1zzzcoding",
      selectedProfileId: current.id,
      profileState: "idle",
      profileError: null,
      onProfileNameChange: () => undefined,
      onSelectedProfileChange: () => undefined,
      onSaveProfile: () => Promise.resolve(true),
      onApplyProfile: () => Promise.resolve(),
      onUpdateProfile: () => Promise.resolve(),
      onReorderProfiles: () => Promise.resolve(),
      onDuplicateProfile: () => Promise.resolve(),
      onCreateProfileForOtherScope: () => undefined,
      onDeleteProfile: () => Promise.resolve()
    }));

    expect(markup).toContain("重命名并应用当前 Codex 档案");
    expect(markup).not.toContain("保存当前 Codex 草稿为新档案");
  });
});

function profile(name: string, id = name.toLowerCase().replaceAll(" ", "-")): PublicConfig["profiles"][number] {
  return {
    id,
    scope: "codex",
    name,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    primary_base_url: "http://127.0.0.1:9101/v1",
    primary_state_domain_id: "",
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
    primary_upstream_protocol: "openai_responses",
    compact_upstream_protocol: "openai_responses",
    claude_primary_upstream_protocol: null,
    claude_compact_upstream_protocol: null,
    stored_api_key_count: 0
  };
}
