import { describe, expect, it } from "vitest";
import type { PublicConfig } from "../src/shared/types.js";
import { startApp } from "./helpers/server-test-utils.js";

const JSON_HEADERS = { "content-type": "application/json" };

async function fetchJson<T>(
  url: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, {
    method,
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  return {
    response,
    body: (await response.json()) as T
  };
}

describe("CompactGate config API", () => {
  it("saves and applies config profiles through the public API", async () => {
    const app = await startApp();

    const { response: saveResponse, body: savedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "POST",
      {
        name: "Profile API",
        config: {
          primary: {
            base_url: "http://127.0.0.1:56001/v1",
            api_key: "profile-api-primary-key"
          },
          compact: {
            base_url: "http://127.0.0.1:56002/v1",
            api_key: "profile-api-compact-key",
            upstream_mode: "split",
            model_mode: "custom",
            model_override: "profile-api-compact-model"
          },
          claude: {
            primary: {
              base_url: "http://127.0.0.1:56003",
              api_key: "profile-api-claude-primary-key"
            },
            compact: {
              base_url: "http://127.0.0.1:56004",
              api_key: "profile-api-claude-compact-key"
            }
          }
        }
      }
    );

    expect(saveResponse.status).toBe(200);
    expect(savedConfig.profiles).toHaveLength(1);
    expect(savedConfig.profiles[0]).toMatchObject({
      scope: "codex",
      name: "Profile API",
      primary_host: "127.0.0.1:56001",
      compact_host: "127.0.0.1:56002",
      claude_primary_host: null,
      claude_compact_host: null,
      compact_upstream_mode: "split",
      claude_compact_upstream_mode: null,
      stored_api_key_count: 2
    });
    expect(savedConfig.active_profile_id).toBeNull();
    expect(savedConfig.route_url_presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "codex_primary", base_url: "http://127.0.0.1:56001/v1" }),
        expect.objectContaining({ kind: "codex_compact", base_url: "http://127.0.0.1:56002/v1" })
      ])
    );
    expect(JSON.stringify(savedConfig)).not.toContain("profile-api-primary-key");
    expect(JSON.stringify(savedConfig)).not.toContain("profile-api-claude-compact-key");

    const profileId = savedConfig.profiles[0].id;
    const { response: listResponse, body: listedProfiles } = await fetchJson<Pick<PublicConfig, "profiles" | "active_profile_id">>(
      `${app.url}/api/config/profiles`,
      "GET"
    );

    expect(listResponse.status).toBe(200);
    expect(listedProfiles.profiles).toHaveLength(1);
    expect(listedProfiles.profiles[0]).toMatchObject({
      id: profileId,
      name: "Profile API"
    });
    expect(listedProfiles.active_profile_id).toBeNull();
    expect(JSON.stringify(listedProfiles)).not.toContain("profile-api-primary-key");
    expect(JSON.stringify(listedProfiles)).not.toContain("profile-api-claude-compact-key");

    const { response: applyResponse, body: appliedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/apply`,
      "POST",
      { profile_id: profileId }
    );

    expect(applyResponse.status).toBe(200);
    expect(appliedConfig.active_profile_id).toBe(profileId);
    expect(appliedConfig.primary.base_url).toBe("http://127.0.0.1:56001/v1");
    expect(appliedConfig.compact.base_url).toBe("http://127.0.0.1:56002/v1");
    expect(appliedConfig.compact.model_override).toBe("profile-api-compact-model");
    expect(appliedConfig.claude.compact.base_url).toBe("https://api.anthropic.com");
    expect(JSON.stringify(appliedConfig)).not.toContain("profile-api-primary-key");

    const { response: claudeSaveResponse, body: claudeSavedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "POST",
      {
        scope: "claude",
        name: "Claude Profile API",
        config: {
          claude: {
            primary: { base_url: "http://127.0.0.1:56013" },
            compact: { base_url: "http://127.0.0.1:56014", upstream_mode: "split" }
          }
        }
      }
    );
    expect(claudeSaveResponse.status).toBe(200);
    const claudeProfileId = claudeSavedConfig.profile_scopes.claude.profiles[0].id;
    expect(claudeSavedConfig.profile_scopes.claude.profiles[0]).toMatchObject({
      scope: "claude",
      primary_host: null,
      compact_host: null,
      claude_primary_host: "127.0.0.1:56013",
      claude_compact_host: "127.0.0.1:56014",
      compact_upstream_mode: null,
      claude_compact_upstream_mode: "split"
    });

    const { response: claudeApplyResponse, body: claudeAppliedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/apply`,
      "POST",
      { scope: "claude", profile_id: claudeProfileId }
    );

    expect(claudeApplyResponse.status).toBe(200);
    expect(claudeAppliedConfig.primary.base_url).toBe("http://127.0.0.1:56001/v1");
    expect(claudeAppliedConfig.claude.primary.base_url).toBe("http://127.0.0.1:56013");
    expect(claudeAppliedConfig.claude.compact.base_url).toBe("http://127.0.0.1:56014");
    expect(claudeAppliedConfig.profile_scopes.codex.active_profile_id).toBe(profileId);
    expect(claudeAppliedConfig.profile_scopes.claude.active_profile_id).toBe(claudeProfileId);

    const { body: preview } = await fetchJson<{
      target_model: string;
      upstream_host: string;
    }>(
      `${app.url}/api/test-route`,
      "POST",
      {
        path: "/v1/responses/compact",
        body: { model: "gpt-5.5" }
      }
    );

    expect(preview.target_model).toBe("profile-api-compact-model");
    expect(preview.upstream_host).toBe("127.0.0.1:56002");

    const { response: activeCodexResaveResponse, body: activeCodexResavedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "POST",
      {
        scope: "codex",
        name: "Profile API",
        config: {
          primary: { base_url: "http://127.0.0.1:56018/v1" },
          compact: {
            model_mode: "custom",
            model_override: "profile-api-resaved-model"
          }
        }
      }
    );

    expect(activeCodexResaveResponse.status).toBe(200);
    expect(activeCodexResavedConfig.active_profile_id).toBe(profileId);
    expect(activeCodexResavedConfig.primary.base_url).toBe("http://127.0.0.1:56018/v1");
    expect(activeCodexResavedConfig.compact.model_override).toBe("profile-api-resaved-model");

    const { response: activeCodexUpdateResponse, body: activeCodexUpdatedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "PATCH",
      {
        scope: "codex",
        profile_id: profileId,
        config: {
          primary: { base_url: "http://127.0.0.1:56015/v1" },
          compact: { model_override: "profile-api-active-update-model" },
          claude: {
            primary: { base_url: "http://127.0.0.1:56998" }
          }
        }
      }
    );

    expect(activeCodexUpdateResponse.status).toBe(200);
    expect(activeCodexUpdatedConfig.primary.base_url).toBe("http://127.0.0.1:56015/v1");
    expect(activeCodexUpdatedConfig.compact.model_override).toBe("profile-api-active-update-model");
    expect(activeCodexUpdatedConfig.claude.primary.base_url).toBe("http://127.0.0.1:56013");

    const { response: activeClaudeUpdateResponse, body: activeClaudeUpdatedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "PATCH",
      {
        scope: "claude",
        profile_id: claudeProfileId,
        config: {
          claude: {
            primary: { base_url: "http://127.0.0.1:56016" },
            compact: { base_url: "http://127.0.0.1:56017", upstream_mode: "primary" }
          },
          primary: { base_url: "http://127.0.0.1:56999/v1" }
        }
      }
    );

    expect(activeClaudeUpdateResponse.status).toBe(200);
    expect(activeClaudeUpdatedConfig.primary.base_url).toBe("http://127.0.0.1:56015/v1");
    expect(activeClaudeUpdatedConfig.claude.primary.base_url).toBe("http://127.0.0.1:56016");
    expect(activeClaudeUpdatedConfig.claude.compact.base_url).toBe("http://127.0.0.1:56017");
    expect(activeClaudeUpdatedConfig.claude.compact.upstream_mode).toBe("primary");

    const { response: patchResponse, body: patchedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config`,
      "PATCH",
      {
        primary: {
          base_url: "http://127.0.0.1:56005/v1"
        }
      }
    );

    expect(patchResponse.status).toBe(200);
    expect(patchedConfig.active_profile_id).toBe(profileId);
    expect(patchedConfig.profile_scopes.codex.active_profile_id).toBe(profileId);
    expect(patchedConfig.profile_scopes.claude.active_profile_id).toBe(claudeProfileId);
    expect(patchedConfig.primary.base_url).toBe("http://127.0.0.1:56005/v1");
    expect(patchedConfig.profiles).toHaveLength(1);
    expect(patchedConfig.profiles[0]).toMatchObject({
      id: profileId,
      primary_host: "127.0.0.1:56005"
    });
    expect(JSON.stringify(patchedConfig)).not.toContain("profile-api-primary-key");

    const { response: updateResponse, body: updatedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "PATCH",
      {
        profile_id: profileId,
        name: "Profile API Updated",
        config: {
          compact: {
            model_override: "profile-api-updated-model"
          }
        }
      }
    );

    expect(updateResponse.status).toBe(200);
    expect(updatedConfig.profiles).toHaveLength(1);
    expect(updatedConfig.profiles[0]).toMatchObject({
      id: profileId,
      name: "Profile API Updated"
    });
    expect(JSON.stringify(updatedConfig)).not.toContain("profile-api-primary-key");

    const { response: duplicateResponse, body: duplicatedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/duplicate`,
      "POST",
      {
        profile_id: profileId,
        name: "Profile API Copy"
      }
    );
    const copiedProfile = duplicatedConfig.profiles.find((profile) => profile.name === "Profile API Copy");

    expect(duplicateResponse.status).toBe(200);
    expect(duplicatedConfig.profiles).toHaveLength(2);
    expect(copiedProfile?.id).toBeTruthy();
    expect(copiedProfile?.id).not.toBe(profileId);
    expect(JSON.stringify(duplicatedConfig)).not.toContain("profile-api-primary-key");

    const { response: deleteResponse, body: deletedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "DELETE",
      {
        profile_id: profileId
      }
    );

    expect(deleteResponse.status).toBe(200);
    expect(deletedConfig.profiles).toHaveLength(1);
    expect(deletedConfig.profiles[0].id).toBe(copiedProfile?.id);
    expect(deletedConfig.active_profile_id).toBeNull();
    expect(JSON.stringify(deletedConfig)).not.toContain("profile-api-primary-key");
  });

  it("reorders scoped config profiles through the public API", async () => {
    const app = await startApp();

    async function saveProfile(name: string, baseUrl: string): Promise<string> {
      const { response, body } = await fetchJson<PublicConfig>(
        `${app.url}/api/config/profiles`,
        "POST",
        {
          scope: "codex",
          name,
          config: {
            primary: {
              base_url: `${baseUrl}/v1`,
              api_key: `${name.toLowerCase().replaceAll(" ", "-")}-secret`
            },
            compact: { base_url: `${baseUrl}/compact/v1` }
          }
        }
      );

      expect(response.status).toBe(200);
      return body.profile_scopes.codex.profiles.find((profile) => profile.name === name)?.id ?? "";
    }

    const firstId = await saveProfile("Profile First", "http://127.0.0.1:56101");
    const secondId = await saveProfile("Profile Second", "http://127.0.0.1:56102");
    const thirdId = await saveProfile("Profile Third", "http://127.0.0.1:56103");
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(thirdId).toBeTruthy();

    const { body: claudeSaved } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "POST",
      {
        scope: "claude",
        name: "Claude Scoped",
        config: {
          claude: {
            primary: { base_url: "http://127.0.0.1:56111", api_key: "claude-scoped-secret" },
            compact: { base_url: "http://127.0.0.1:56112" }
          }
        }
      }
    );
    const claudeId = claudeSaved.profile_scopes.claude.profiles[0].id;

    const { response: applyResponse } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/apply`,
      "POST",
      { scope: "codex", profile_id: secondId }
    );
    expect(applyResponse.status).toBe(200);

    const { response: reorderResponse, body: reordered } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/reorder`,
      "POST",
      {
        scope: "codex",
        profile_ids: [thirdId, firstId, secondId]
      }
    );

    expect(reorderResponse.status).toBe(200);
    expect(reordered.profile_scopes.codex.profiles.map((profile) => profile.id)).toEqual([
      thirdId,
      firstId,
      secondId
    ]);
    expect(reordered.profile_scopes.codex.active_profile_id).toBe(secondId);
    expect(reordered.profile_scopes.claude.profiles.map((profile) => profile.id)).toEqual([claudeId]);
    expect(JSON.stringify(reordered)).not.toContain("profile-first-secret");
    expect(JSON.stringify(reordered)).not.toContain("claude-scoped-secret");

    const { response: duplicateResponse } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/reorder`,
      "POST",
      {
        scope: "codex",
        profile_ids: [thirdId, thirdId, secondId]
      }
    );
    expect(duplicateResponse.status).toBe(400);

    const { response: crossScopeResponse } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/reorder`,
      "POST",
      {
        scope: "codex",
        profile_ids: [thirdId, firstId, claudeId]
      }
    );
    expect(crossScopeResponse.status).toBe(400);
  });
});
