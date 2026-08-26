import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import {
  applyDraftToConfigExport,
  emptyForm,
  formFromConfig,
  formToPatch,
  isFormDirty
} from "../src/ui/config/config-form-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("UI config form state", () => {
  it("serializes the primary failover auto scheduling switch", () => {
    const form = {
      ...emptyForm(),
      autoSchedulePrimaryFailover: false,
      primaryStatePortability: "recover_on_error" as const
    };

    expect(formToPatch(form)).toMatchObject({
      primary_failover: {
        auto_schedule: false,
        state_portability: "recover_on_error"
      }
    });
  });

  it("round-trips upstream protocols through patches and export drafts", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    const form = {
      ...formFromConfig(store.toPublicConfig()),
      codexPrimaryUpstreamProtocol: "anthropic_messages" as const,
      codexCompactUpstreamProtocol: "openai_chat" as const,
      claudePrimaryUpstreamProtocol: "openai_responses" as const,
      claudeCompactUpstreamProtocol: "openai_chat" as const
    };

    expect(formToPatch(form)).toMatchObject({
      primary: { upstream_protocol: "anthropic_messages" },
      compact: { upstream_protocol: "openai_chat" },
      claude: {
        primary: { upstream_protocol: "openai_responses" },
        compact: { upstream_protocol: "openai_chat" }
      }
    });
    expect(applyDraftToConfigExport(store.get(), form)).toMatchObject({
      primary: { upstream_protocol: "anthropic_messages" },
      compact: { upstream_protocol: "openai_chat" },
      claude: {
        primary: { upstream_protocol: "openai_responses" },
        compact: { upstream_protocol: "openai_chat" }
      }
    });
    expect(isFormDirty(store.toPublicConfig(), form)).toBe(true);
  });

  it("serializes hidden credential preset ids for route URL selections", () => {
    const form = {
      ...emptyForm(),
      codexPrimaryBaseUrl: "http://127.0.0.1:9051/v1",
      codexPrimaryCredentialPresetId: "codex-primary-preset",
      codexCompactBaseUrl: "http://127.0.0.1:9052/v1",
      codexCompactCredentialPresetId: "codex-compact-preset",
      claudePrimaryBaseUrl: "http://127.0.0.1:9053",
      claudePrimaryCredentialPresetId: "claude-primary-preset"
    };

    expect(formToPatch(form)).toMatchObject({
      primary: {
        base_url: "http://127.0.0.1:9051/v1",
        credential_preset_id: "codex-primary-preset"
      },
      compact: {
        base_url: "http://127.0.0.1:9052/v1",
        credential_preset_id: "codex-compact-preset"
      },
      claude: {
        primary: {
          base_url: "http://127.0.0.1:9053",
          credential_preset_id: "claude-primary-preset"
        }
      }
    });
  });

  it("serializes an empty primary model override as passthrough", () => {
    const form = {
      ...emptyForm(),
      primaryModelOverride: ""
    };

    expect(formToPatch(form)).toMatchObject({
      primary: {
        model_override: ""
      }
    });
  });

  it("keeps an empty primary model override empty when reloading config", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    await store.patch({
      primary: {
        model_override: ""
      }
    });

    expect(formFromConfig(store.toPublicConfig()).primaryModelOverride).toBe("");
  });

  it("round-trips the Primary reasoning effort through patch and export drafts", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    await store.patch({
      primary: { reasoning_effort: "high" }
    });
    const form = formFromConfig(store.toPublicConfig());

    expect(form.primaryReasoningEffort).toBe("high");
    expect(formToPatch(form).primary).toMatchObject({ reasoning_effort: "high" });
    expect(applyDraftToConfigExport(store.get(), {
      ...form,
      primaryReasoningEffort: "max"
    }).primary.reasoning_effort).toBe("max");
    expect(isFormDirty(store.toPublicConfig(), form)).toBe(false);
    expect(isFormDirty(store.toPublicConfig(), {
      ...form,
      primaryReasoningEffort: "low"
    })).toBe(true);
  });

  it("round-trips bounded logging storage settings in readable units", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));
    await store.patch({
      logging: {
        redact_body: false,
        persist_body: false,
        keep_recent: 321,
        capture_dir: "./captures",
        capture_body_max_bytes: 2 * 1024 * 1024,
        capture_dir_max_bytes: 12 * 1024 * 1024 * 1024,
        max_database_bytes: 768 * 1024 * 1024
      }
    });
    const config = store.toPublicConfig();
    const form = formFromConfig(config);

    expect(form).toMatchObject({
      loggingPersistBody: false,
      loggingKeepRecent: 321,
      loggingCaptureDir: "./captures",
      loggingCaptureBodyMaxMiB: 2,
      loggingCaptureDirMaxGiB: 12,
      loggingMaxDatabaseMiB: 768
    });
    expect(formToPatch(form)).toMatchObject({
      logging: {
        persist_body: false,
        keep_recent: 321,
        capture_dir: "./captures",
        capture_body_max_bytes: 2 * 1024 * 1024,
        capture_dir_max_bytes: 12 * 1024 * 1024 * 1024,
        max_database_bytes: 768 * 1024 * 1024
      }
    });
    expect(formToPatch(form).logging).not.toHaveProperty("redact_body");
    expect(applyDraftToConfigExport(store.get(), form).logging.redact_body).toBe(false);
    expect(isFormDirty(config, form)).toBe(false);
    expect(isFormDirty(config, { ...form, loggingKeepRecent: 322 })).toBe(true);
  });
});

describe("UI key pool form state", () => {
  it("round-trips key entries through the patch with empty secrets meaning unchanged", async () => {
    const dir = await makeConfigDir();
    const storeWithPool = await ConfigStore.load(path.join(dir, "compactgate.json"));
    // Seed a stored pool through the real merge path.
    const patched = await storeWithPool.patch({
      primary: {
        ...storeWithPool.get().primary,
        api_keys: [
          { id: "saved-1", label: "主号", api_key: "sk-stored", enabled: true },
          { id: "saved-2", label: "备用", api_key: "sk-spare", enabled: false }
        ]
      }
    });
    if (!("primary" in patched)) {
      throw new Error("Expected patched config.");
    }

    const form = formFromConfig(storeWithPool.toPublicConfig());
    expect(form.codexPrimaryApiKeys).toEqual([
      { id: "saved-1", label: "主号", apiKey: "", enabled: true, tail: "ored" },
      { id: "saved-2", label: "备用", apiKey: "", enabled: false, tail: "pare" }
    ]);

    // Typing a new secret for the first entry and adding a third.
    const dirty = {
      ...form,
      codexPrimaryApiKeys: [
        { ...form.codexPrimaryApiKeys[0], apiKey: "sk-rotated" },
        form.codexPrimaryApiKeys[1],
        { id: "draft-3", label: "新钥匙", apiKey: "sk-new", enabled: true, tail: "" }
      ],
      codexPrimaryKeyStrategy: "spread" as const,
      codexPrimaryStickyReserveSeconds: 300
    };

    const patch = formToPatch(dirty);
    expect(patch.primary.api_keys).toEqual([
      // Stored secret travels as absent so the server inherits by id.
      { id: "saved-1", label: "主号", enabled: true, api_key: "sk-rotated" },
      { id: "saved-2", label: "备用", enabled: false },
      { id: "draft-3", label: "新钥匙", enabled: true, api_key: "sk-new" }
    ]);
    expect(patch.primary).toMatchObject({
      key_strategy: "spread",
      sticky_reserve_seconds: 300
    });
    expect(isFormDirty(storeWithPool.toPublicConfig(), dirty)).toBe(true);

    // The export baseline keeps the stored secret for the untouched entry.
    expect(applyDraftToConfigExport(storeWithPool.get(), dirty)).toMatchObject({
      primary: {
        key_strategy: "spread",
        api_keys: [
          { id: "saved-1", label: "主号", api_key: "sk-rotated", enabled: true },
          { id: "saved-2", label: "备用", api_key: "sk-spare", enabled: false },
          { id: "draft-3", label: "新钥匙", api_key: "sk-new", enabled: true }
        ]
      }
    });
  });

  it("defaults the pool to an empty list in the pristine form", () => {
    const form = emptyForm();

    expect(form.codexPrimaryApiKeys).toEqual([]);
    expect(form.codexPrimaryKeyStrategy).toBe("fill_first");
    expect(form.codexPrimaryRotationOptOut).toBe(false);
    expect(form.codexPrimaryStickyReserveSeconds).toBe(0);
    expect(formToPatch(form).primary.api_keys).toEqual([]);
  });
});
