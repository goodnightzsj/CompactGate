import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { buildPublicConfig } from "../src/server/config-public.js";

afterEach(() => vi.unstubAllEnvs());

it("tracks hidden connection material even when it does not select the model catalogue credential", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.primary.api_key_env = "COMPACTGATE_TEST_CONNECTION_REVISION";
  vi.stubEnv(config.primary.api_key_env, "synthetic-env-first");
  config.primary.api_keys = [{ id: "preferred", label: "Preferred", api_key: "synthetic-pool", enabled: true, priority: 100 }];
  const project = () => buildPublicConfig({ config, configPath: "/synthetic/config.json", lastSavedAt: null, revision: "test" }).primary;
  const modelSource = project().model_source_revision;
  let previous = project().connection_revision;
  for (const change of [
    () => { config.primary.api_key = "synthetic-direct"; },
    () => { vi.stubEnv(config.primary.api_key_env, "synthetic-env-second"); },
    () => { config.primary.api_keys!.push({ id: "inactive", label: "Inactive", api_key: "synthetic-inactive", enabled: false, priority: 0 }); }
  ]) {
    change();
    const next = project();
    expect(next.model_source_revision).toBe(modelSource);
    expect(next.connection_revision).not.toBe(previous);
    expect(next.connection_revision).toMatch(/^[\w-]{43}$/);
    previous = next.connection_revision;
  }
  expect(JSON.stringify(project())).not.toMatch(/synthetic-(?:direct|env|pool|inactive)/);
});

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
