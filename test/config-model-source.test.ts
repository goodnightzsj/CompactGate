import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { buildPublicConfig } from "../src/server/config-public.js";

describe("public model catalogue identity", () => {
  it.each(["codex", "claude"] as const)("tracks the effective %s connection without leaking its credentials", (scope) => {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const route of [config.primary, config.compact, config.claude.primary, config.claude.compact]) {
      route.api_key = "synthetic-initial-same";
      route.api_key_env = "";
      route.api_keys = [];
    }
    const project = () => buildPublicConfig({ config, configPath: "/synthetic/config.json", lastSavedAt: null, revision: "test" });
    const source = () => {
      const value = project();
      return (scope === "codex" ? value.primary : value.claude.primary).model_source_revision;
    };
    const route = scope === "codex" ? config.primary : config.claude.primary;
    const first = source();
    expect(first).toMatch(/^[\w-]{43}$/);
    config.logging.keep_recent = 100;
    route.model_override = "different-model";
    expect(source()).toBe(first);
    // Equal tail and source type must not hide a credential replacement.
    route.api_key = "synthetic-replaced-same";
    const replaced = source();
    expect(replaced).not.toBe(first);
    route.api_keys = [{ id: "preferred", label: "Preferred", api_key: "synthetic-pool-secret", enabled: true, priority: 90 }];
    const pooled = source();
    expect(pooled).not.toBe(replaced);
    route.api_keys[0].label = "Renamed";
    expect(source()).toBe(pooled);
    route.api_keys[0].enabled = false;
    expect(source()).toBe(replaced);
    route.upstream_protocol = "openai_chat";
    const protocol = source();
    expect(protocol).not.toBe(replaced);
    route.extra_headers = { "x-account": "synthetic-header-secret" };
    expect(source()).not.toBe(protocol);
    const projected = JSON.stringify(project());
    for (const secret of ["synthetic-replaced-same", "synthetic-pool-secret", "synthetic-header-secret"]) {
      expect(projected).not.toContain(secret);
    }
  });
});
