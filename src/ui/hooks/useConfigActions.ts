import { type Dispatch, type FormEvent, type SetStateAction, useState } from "react";
import type {
  HealthResponse,
  PublicConfig
} from "../../shared/types.js";
import {
  formToPatch
} from "../config/config-form-state.js";
import type { ConfigFormState, SaveState } from "../config/types.js";
import { api, errorSummary } from "../shared/api.js";
import { createConfigPortableActions } from "./configPortableActions.js";
import { useConfigProfileActions } from "./useConfigProfileActions.js";
import { useRoutePreviewAction } from "./useRoutePreviewAction.js";

export function useConfigActions({
  config,
  form,
  linkedCompactModel,
  draftRevision,
  commitConfig,
  setConfig,
  setForm,
  setHealth,
  setPageError
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  linkedCompactModel: string;
  draftRevision: number;
  commitConfig: (config: PublicConfig, submittedRevision: number) => void;
  setConfig: Dispatch<SetStateAction<PublicConfig | null>>;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
  setHealth: Dispatch<SetStateAction<HealthResponse | null>>;
  setPageError: Dispatch<SetStateAction<string | null>>;
}) {
  const routePreview = useRoutePreviewAction();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const profileActions = useConfigProfileActions({
    config,
    form,
    setConfig,
    setForm,
    setHealth,
    setSaveError,
    setSaveState
  });
  const { exportConfig, importConfig } = createConfigPortableActions({
    config,
    form,
    setConfig,
    setForm,
    setHealth,
    setPageError,
    setSaveError,
    setSaveState
  });

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    const submittedRevision = draftRevision;
    setSaveState("saving");
    setSaveError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config", {
        method: "PATCH",
        body: JSON.stringify(formToPatch(form))
      });
      const nextHealth = await api<HealthResponse>("/api/health", {
        method: "GET"
      });
      commitConfig(nextConfig, submittedRevision);
      setHealth(nextHealth);
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1400);
    } catch (error) {
      setSaveState("error");
      setSaveError(errorSummary(error));
    }
  }

  function unlockCompactModel() {
    setForm((previous) => ({
      ...previous,
      modelMode: "custom",
      modelOverride: previous.modelOverride || linkedCompactModel
    }));
  }

  function restoreLinkedMode() {
    setForm((previous) => ({
      ...previous,
      modelMode: "linked",
      modelOverride: ""
    }));
  }

  return {
    ...profileActions,
    exportConfig,
    importConfig,
    ...routePreview,
    restoreLinkedMode,
    saveConfig,
    saveError,
    saveState,
    unlockCompactModel
  };
}

export type ConfigActions = ReturnType<typeof useConfigActions>;
