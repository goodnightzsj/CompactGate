import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, DEFAULT_CONFIG } from "../src/server/config.js";
import { validateImportedConfigContainers } from "../src/server/config-import-validation.js";
import { ConfigError } from "../src/server/config-internals.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

function at(field: string, value: unknown): Record<string, unknown> {
  const [first, ...rest] = field.split(".");
  return { [first]: rest.length ? at(rest.join("."), value) : value };
}

const runtimeObjects = [
  "primary", "compact", "timeouts", "logging", "primary_failover", "claude",
  "primary.extra_headers", "compact.extra_headers", "claude.extra_headers",
  "claude.primary", "claude.compact", "claude.primary.extra_headers", "claude.compact.extra_headers",
  "claude.model_map", "claude.scene_map", "claude.scene_map.default", "claude.scene_map.long_context",
  "claude.scene_map.background", "claude.scene_map.web_search", "claude.scene_map.thinking", "claude.scene_map.image"
];
const runtimeLists = [
  "primary.api_keys", "compact.api_keys", "claude.api_keys", "claude.primary.api_keys", "claude.compact.api_keys"
];
const profile = (config: unknown) => ({ id: "synthetic", name: "Synthetic", config });

describe("container validator", () => {
  it.each(runtimeObjects)("rejects malformed %s in runtime and saved profiles", (field) => {
    for (const value of [null, [], false, "bad"]) {
      const config = at(field, value);
      for (const input of [config, { profiles: [profile(config)] },
        { profile_scopes: { codex: { profiles: [profile(config)] } } },
        { profile_scopes: { claude: { profiles: [profile(config)] } } }]) {
        expect(() => validateImportedConfigContainers(input)).toThrow(`${field} must be a JSON object.`);
      }
    }
  });

  it.each([...runtimeLists, "profiles", "route_url_presets", "profile_scopes.codex.profiles", "profile_scopes.claude.profiles"])(
    "rejects malformed %s lists", (field) => {
      for (const value of [null, {}, false, "bad"]) {
        expect(() => validateImportedConfigContainers(at(field, value))).toThrow(`${field} must be an array.`);
      }
    }
  );

  it.each(["profile_scopes", "profile_scopes.codex", "profile_scopes.claude"])("rejects malformed %s", (field) => {
    for (const value of [null, [], false, "bad"]) {
      expect(() => validateImportedConfigContainers(at(field, value))).toThrow(`${field} must be a JSON object.`);
    }
  });

  it.each([null, [], false, "bad"])("rejects malformed profile config %j", (config) => {
    for (const input of [{ profiles: [profile(config)] },
      { profile_scopes: { codex: { profiles: [profile(config)] } } },
      { profile_scopes: { claude: { profiles: [profile(config)] } } }]) {
      expect(() => validateImportedConfigContainers(input)).toThrow("config must be a JSON object.");
    }
  });

  it("accepts omitted and empty containers without inspecting unknown fields or entry business rules", () => {
    for (const field of runtimeObjects) expect(() => validateImportedConfigContainers(at(field, {}))).not.toThrow();
    for (const field of runtimeLists) expect(() => validateImportedConfigContainers(at(field, []))).not.toThrow();
    expect(() => validateImportedConfigContainers({})).not.toThrow();
    expect(() => validateImportedConfigContainers({ ...DEFAULT_CONFIG })).not.toThrow();
    expect(() => validateImportedConfigContainers({ profiles: [null], route_url_presets: [false], unknown: [] })).not.toThrow();
  });
});

const invalidImports = [
  { profile_scopes: [] }, { profile_scopes: { codex: "bad" } },
  { profile_scopes: { claude: { profiles: null } } },
  { profile_scopes: { codex: { profiles: {} } } },
  { profiles: {} }, { route_url_presets: null }, { primary: [] },
  { claude: { primary: false } }, { claude: { model_map: [] } },
  { claude: { scene_map: { thinking: null } } },
  { profiles: [profile(null)] },
  { profile_scopes: { codex: { profiles: [profile([])] } } },
  { profile_scopes: { claude: { profiles: [profile({ claude: { compact: [] } })] } } },
  { profiles: [profile({ primary: { api_keys: {} } })] }
];

describe("strict config import", () => {
  it.each(invalidImports)("rejects malformed containers without mutating any saved state: %j", async (input) => {
    const file = path.join(await makeConfigDir(), "synthetic.json");
    const store = await ConfigStore.load(file);
    try {
      await store.patch({ primary: { model_override: "synthetic-retained-model" } });
      await store.saveProfile("codex", "Synthetic retained", {});
      const before = store.get();
      const revision = store.revision;
      const persisted = await readFile(file, "utf8");
      const backups = await store.listBackups();

      await expect(store.importConfig(input)).rejects.toBeInstanceOf(ConfigError);

      expect(store.get()).toEqual(before);
      expect(store.revision).toBe(revision);
      expect(await readFile(file, "utf8")).toBe(persisted);
      expect(await store.listBackups()).toEqual(backups);
    } finally { store.oauth.close(); }
  });

  it("preserves the existing permissive patch contract", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "synthetic.json"));
    try {
      await store.patch({ primary: { model_override: "synthetic-retained-model" } });
      const patched = await store.patch({ primary: [], profile_scopes: null, route_url_presets: {} });
      expect(patched.primary.model_override).toBe("synthetic-retained-model");
      const junk = await store.patch({ profile_scopes: { codex: { profiles: [null] } }, route_url_presets: [null] });
      expect(junk.profile_scopes?.codex?.profiles).toEqual([]);
    } finally { store.oauth.close(); }
  });

  it.each([false, true])("imports legacy profiles with empty scope containers present=%s", async (emptyScopes) => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "synthetic.json"));
    try {
      const imported = await store.importConfig({
        profiles: [
          { ...profile({ primary: { base_url: "https://synthetic.invalid/v1", api_keys: [], extra_headers: {} } }), id: "legacy-codex" },
          { ...profile({ claude: { base_url: "https://synthetic.invalid/claude", extra_headers: {} } }), id: "legacy-claude" }
        ],
        ...(emptyScopes ? { profile_scopes: { codex: { profiles: [] }, claude: { profiles: [] } } } : {})
      });
      expect(imported.profile_scopes?.codex?.profiles?.map((item) => item.id)).toEqual(["legacy-codex"]);
      expect(imported.profile_scopes?.claude?.profiles?.map((item) => item.id)).toEqual(["legacy-claude"]);
      expect(imported.profile_scopes?.claude?.profiles?.[0]?.config).toMatchObject({
        claude: { primary: { base_url: "https://synthetic.invalid/claude" } }
      });
    } finally { store.oauth.close(); }
  });

  it("accepts an export round trip, empty objects, and explicit empty lists", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "synthetic.json"));
    try {
      await store.saveProfile("codex", "Synthetic", {});
      const exported = store.get();
      expect(await store.importConfig(exported)).toEqual(exported);
      const cleared = await store.importConfig({
        primary: {}, compact: {}, claude: { primary: {}, compact: {}, model_map: {}, scene_map: { default: {} } },
        profiles: [], profile_scopes: { codex: { profiles: [] }, claude: { profiles: [] } }, route_url_presets: []
      });
      expect(cleared.profile_scopes?.codex?.profiles).toEqual([]);
      expect(cleared.profile_scopes?.claude?.profiles).toEqual([]);
      expect(cleared.route_url_presets).toEqual([]);
      await expect(store.importConfig({})).resolves.toBeTruthy();
    } finally { store.oauth.close(); }
  });

  it("still delegates invalid entry semantics to the existing strict merge validation", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "synthetic.json"));
    try {
      await expect(store.importConfig({ profiles: [null] })).rejects.toThrow("profile must be a JSON object.");
      await expect(store.importConfig({ profiles: [{ name: "No ID", config: {} }] })).rejects.toThrow("profile.id is required.");
      await expect(store.importConfig({ route_url_presets: [{ kind: "codex_primary", base_url: "bad" }] }))
        .rejects.toThrow("route_url_presets.codex_primary.base_url must be a valid http or https URL.");
    } finally { store.oauth.close(); }
  });
});
