import { describe, expect, it } from "vitest";
import {
  emptyForm,
  formToPatch
} from "../src/ui/config/config-form-state.js";

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
});
