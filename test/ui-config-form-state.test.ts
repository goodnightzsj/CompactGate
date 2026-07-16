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
      autoSchedulePrimaryFailover: false
    };

    expect(formToPatch(form)).toMatchObject({
      primary_failover: {
        auto_schedule: false
      }
    });
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
