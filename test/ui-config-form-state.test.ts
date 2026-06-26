import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import {
  emptyForm,
  formFromConfig,
  formToPatch
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
});
