import { type Dispatch, type FormEvent, type SetStateAction, useState } from "react";
import type {
  CompactGateConfig,
  HealthResponse,
  PublicConfig
} from "../../shared/types.js";
import {
  applyDraftToConfigExport,
  formFromConfig,
  formToPatch
} from "../config/config-form-state.js";
import type { ConfigFormState, SaveState } from "../config/types.js";
import { api, errorSummary } from "../shared/api.js";
import { createConfigProfileCollectionActions } from "./configProfileCollectionActions.js";
import { createConfigProfilePersistenceActions } from "./configProfilePersistenceActions.js";
import { useRoutePreviewAction } from "./useRoutePreviewAction.js";
import { useScopedProfileControls } from "./useScopedProfileControls.js";

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
  const {
    claudeProfileError,
    claudeProfileName,
    claudeProfileState,
    profileDeleteCandidate,
    profileError,
    profileName,
    profileState,
    scopedProfileAccessors,
    selectedClaudeProfileId,
    selectedProfileId,
    setClaudeProfileName,
    setProfileDeleteCandidate,
    setProfileName
  } = useScopedProfileControls(config);
  const persistenceActions = createConfigProfilePersistenceActions({
    config,
    form,
    setConfig,
    setForm,
    setHealth,
    setSaveError,
    setSaveState,
    scopedProfileAccessors
  });
  const collectionActions = createConfigProfileCollectionActions({
    config,
    profileDeleteCandidate,
    setConfig,
    setProfileDeleteCandidate,
    scopedProfileAccessors
  });

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

  async function importConfig(payload: unknown) {
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

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    const submittedRevision = draftRevision;
    setSaveState("saving");
    setSaveError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config", {
        method: "PATCH",
        // Pin the snapshot this form was built from: another tab may have
        // applied a different profile since, and the patch still carries this
        // form's base_url while omitting the untouched api_key.
        body: JSON.stringify({ ...formToPatch(form), revision: config?.revision })
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
    ...persistenceActions,
    ...collectionActions,
    ...routePreview,
    claudeProfileError,
    claudeProfileName,
    claudeProfileState,
    exportConfig,
    importConfig,
    profileDeleteCandidate,
    profileError,
    profileName,
    profileState,
    restoreLinkedMode,
    saveConfig,
    saveError,
    saveState,
    selectedClaudeProfileId,
    selectedProfileId,
    setClaudeProfileName,
    setProfileDeleteCandidate,
    setProfileName,
    unlockCompactModel
  };
}

export type ConfigActions = ReturnType<typeof useConfigActions>;
