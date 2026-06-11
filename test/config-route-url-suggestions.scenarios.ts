import { describe, expect, it } from "vitest";
import type { PublicConfig, PublicConfigProfile } from "../src/shared/types.js";
import { routeUrlSuggestions } from "../src/ui/config/RouteConfigPanel.js";

describe("Route URL suggestions", () => {
  it("keeps persisted compact URLs even when profiles no longer reference them", () => {
    const profileUrl = "http://127.0.0.1:7002/v1";
    const fallbackProfileUrl = "http://127.0.0.1:7003/v1";
    const persistedOnlyUrl = "http://127.0.0.1:7001/v1";
    const profiles = [
      publicCodexProfile("active-profile", "Active profile", profileUrl),
      publicCodexProfile("fallback-profile", "Fallback profile", fallbackProfileUrl)
    ];
    const config = {
      route_url_presets: [
        routeUrlPreset("codex_compact", persistedOnlyUrl, 3, "2026-06-07T00:00:03.000Z", {
          apiKeyEnv: "COMPACT_PRESET_KEY",
          storedApiKey: true,
          apiKeyConfigured: true
        }),
        routeUrlPreset("codex_compact", profileUrl, 2, "2026-06-07T00:00:02.000Z"),
        routeUrlPreset("codex_primary", "http://127.0.0.1:7101/v1", 4, "2026-06-07T00:00:04.000Z")
      ],
      profiles,
      active_profile_id: "active-profile",
      profile_scopes: {
        codex: {
          profiles,
          active_profile_id: "active-profile"
        },
        claude: {
          profiles: [],
          active_profile_id: null
        }
      }
    } as unknown as PublicConfig;

    const suggestions = routeUrlSuggestions(config, "codex_compact");

    expect(suggestions.map((suggestion) => suggestion.baseUrl)).toEqual([
      persistedOnlyUrl,
      profileUrl,
      fallbackProfileUrl
    ]);
    expect(suggestions[0]).toMatchObject({
      credentialPresetId: "codex_compact-3",
      host: "127.0.0.1:7001",
      label: "已保存 3 次",
      apiKeyEnv: "COMPACT_PRESET_KEY",
      storedApiKey: true,
      apiKeyConfigured: true
    });
    expect(suggestions[2]).toMatchObject({
      credentialPresetId: "",
      host: "127.0.0.1:7003",
      label: "档案：Fallback profile"
    });
  });
});

function publicCodexProfile(id: string, name: string, compactBaseUrl: string): PublicConfigProfile {
  return {
    id,
    scope: "codex",
    name,
    created_at: "2026-06-07T00:00:00.000Z",
    updated_at: "2026-06-07T00:00:01.000Z",
    primary_base_url: "http://127.0.0.1:7000/v1",
    compact_base_url: compactBaseUrl,
    claude_primary_base_url: null,
    claude_compact_base_url: null,
    primary_host: "127.0.0.1:7000",
    compact_host: new URL(compactBaseUrl).host,
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

function routeUrlPreset(
  kind: "codex_primary" | "codex_compact",
  baseUrl: string,
  usageCount: number,
  updatedAt: string,
  credentials: {
    apiKeyEnv?: string;
    storedApiKey?: boolean;
    apiKeyConfigured?: boolean;
  } = {}
) {
  return {
    id: `${kind}-${usageCount}`,
    kind,
    base_url: baseUrl,
    api_key_env: credentials.apiKeyEnv ?? "",
    stored_api_key: credentials.storedApiKey ?? false,
    api_key_configured: credentials.apiKeyConfigured ?? false,
    host: new URL(baseUrl).host,
    created_at: "2026-06-07T00:00:00.000Z",
    updated_at: updatedAt,
    usage_count: usageCount
  };
}
