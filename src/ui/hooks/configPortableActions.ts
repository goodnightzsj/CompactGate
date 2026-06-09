import type { Dispatch, SetStateAction } from "react";
import type { CompactGateConfig, HealthResponse, PublicConfig } from "../../shared/types.js";
import {
  applyDraftToConfigExport,
  formFromConfig
} from "../config/config-form-state.js";
import type { ConfigFormState, SaveState } from "../config/types.js";
import { api, errorSummary } from "../shared/api.js";

export function createConfigPortableActions({
  config,
  form,
  setConfig,
  setForm,
  setHealth,
  setPageError,
  setSaveError,
  setSaveState
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  setConfig: Dispatch<SetStateAction<PublicConfig | null>>;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
  setHealth: Dispatch<SetStateAction<HealthResponse | null>>;
  setPageError: Dispatch<SetStateAction<string | null>>;
  setSaveError: Dispatch<SetStateAction<string | null>>;
  setSaveState: Dispatch<SetStateAction<SaveState>>;
}) {
  async function exportConfig() {
    if (!config) {
      return;
    }

    try {
      const savedConfig = await api<CompactGateConfig>("/api/config/export");
      const payload = applyDraftToConfigExport(savedConfig, form);
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "compactgate.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setPageError(errorSummary(error));
    }
  }

  async function importConfig(payload: CompactGateConfig) {
    const nextConfig = await api<PublicConfig>("/api/config/import", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const nextHealth = await api<HealthResponse>("/api/health", {
      method: "GET"
    });

    setConfig(nextConfig);
    setHealth(nextHealth);
    setForm(formFromConfig(nextConfig));
    setSaveError(null);
    setSaveState("saved");
    setPageError(null);
    window.setTimeout(() => setSaveState("idle"), 1600);
  }

  return {
    exportConfig,
    importConfig
  };
}
