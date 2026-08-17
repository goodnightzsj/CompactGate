import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import {
  isLoopbackAddress,
  resolveRequestScopedProfile
} from "../src/server/request-profile.js";
import type { CompactGateConfig, SavedConfigProfile } from "../src/shared/types.js";

function configWithProfile(scope: "codex" | "claude"): CompactGateConfig {
  const profile: SavedConfigProfile = {
    id: `${scope}-selected`,
    name: `${scope} selected`,
    created_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
    config: scope === "codex"
      ? {
          primary: {
            ...DEFAULT_CONFIG.primary,
            base_url: "http://127.0.0.1:9101/v1"
          },
          compact: { ...DEFAULT_CONFIG.compact }
        }
      : {
          claude: {
            ...DEFAULT_CONFIG.claude,
            primary: {
              ...DEFAULT_CONFIG.claude.primary,
              base_url: "http://127.0.0.1:9201"
            }
          }
        }
  };
  return {
    ...structuredClone(DEFAULT_CONFIG),
    profile_scopes: {
      codex: {
        profiles: scope === "codex" ? [profile] : [],
        active_profile_id: null
      },
      claude: {
        profiles: scope === "claude" ? [profile] : [],
        active_profile_id: null
      }
    }
  };
}

describe("request-scoped profiles", () => {
  it("recognizes IPv4 and IPv6 loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.12.0.9")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.9")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("applies an exact profile to a request snapshot", () => {
    const base = configWithProfile("codex");
    const selected = resolveRequestScopedProfile(
      base,
      "codex",
      { "x-compactgate-profile": "codex-selected" },
      "127.0.0.1"
    );

    expect(selected?.config.primary.base_url).toBe("http://127.0.0.1:9101/v1");
    expect(selected?.config.primary_failover.auto_schedule).toBe(false);
    expect(base.primary.base_url).toBe(DEFAULT_CONFIG.primary.base_url);
    expect(base.profile_scopes?.codex?.active_profile_id).toBeNull();
  });

  it("rejects remote callers and stale IDs", () => {
    const base = configWithProfile("claude");
    expect(() => resolveRequestScopedProfile(
      base,
      "claude",
      { "x-compactgate-profile": "claude-selected" },
      "10.0.0.8"
    )).toThrow("only from loopback clients");
    expect(() => resolveRequestScopedProfile(
      base,
      "claude",
      { "x-compactgate-profile": "missing" },
      "::1"
    )).toThrow("Profile not found: missing");
  });
});
