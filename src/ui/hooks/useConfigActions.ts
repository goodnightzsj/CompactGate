import { type Dispatch, type FormEvent, type SetStateAction, useState } from "react";
import type {
  CompactGateConfig,
  ConfigProfileScope,
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
  formRevision,
  commitConfig,
  rebaseFormRevision,
  applyRemoteConfig,
  applyProfileConfig,
  setConfig,
  setForm,
  setHealth,
  setPageError
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  linkedCompactModel: string;
  draftRevision: number;
  formRevision: string | null;
  commitConfig: (config: PublicConfig, submittedRevision: number) => void;
  rebaseFormRevision: () => void;
  applyRemoteConfig: (config: PublicConfig) => void;
  applyProfileConfig: (config: PublicConfig, scope: ConfigProfileScope) => void;
  setConfig: Dispatch<SetStateAction<PublicConfig | null>>;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
  setHealth: Dispatch<SetStateAction<HealthResponse | null>>;
  setPageError: Dispatch<SetStateAction<string | null>>;
}) {
  const routePreview = useRoutePreviewAction();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  // A save refused for a superseded revision is the one error the operator can
  // resolve without losing the draft, so it gets its own affordance instead of a
  // dead end that only a browser reload clears.
  const [saveConflict, setSaveConflict] = useState(false);
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
    formRevision,
    setConfig,
    setForm,
    applyProfileConfig,
    refreshHealthAfterWrite,
    setSaveError,
    setSaveState,
    scopedProfileAccessors
  });
  const collectionActions = createConfigProfileCollectionActions({
    config,
    profileDeleteCandidate,
    onConfigChange: applyRemoteConfig,
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
    setConfig(nextConfig);
    setForm(formFromConfig(nextConfig));
    setSaveError(null);
    setSaveConflict(false);
    setSaveState("saved");
    setPageError(null);
    window.setTimeout(() => setSaveState((current) => current === "saved" ? "idle" : current), 1600);
    await refreshHealthAfterWrite();
  }

  async function refreshHealthAfterWrite() {
    try {
      setHealth(await api<HealthResponse>("/api/health", { method: "GET" }));
      setPageError(null);
    } catch (error) {
      setHealth(null);
      setPageError(`配置已写入，但健康状态刷新失败：${errorSummary(error)}。请重试状态刷新，无需重复保存。`);
    }
  }

  async function submitConfigPatch(revision: string | null | undefined) {
    const submittedRevision = draftRevision;
    setSaveState("saving");
    setSaveError(null);
    setSaveConflict(false);

    try {
      const nextConfig = await api<PublicConfig>("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ ...formToPatch(form), revision })
      });
      commitConfig(nextConfig, submittedRevision);
      setSaveState("saved");
      window.setTimeout(() => setSaveState((current) => current === "saved" ? "idle" : current), 1400);
    } catch (error) {
      const summary = errorSummary(error);
      setSaveState("error");
      setSaveError(summary);
      setSaveConflict(/superseded revision/i.test(summary));
      return;
    }
    await refreshHealthAfterWrite();
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    // Pin the snapshot this form was built from — `formRevision`, not
    // `config.revision`: a snapshot broadcast by another tab refreshes the
    // baseline while this draft survives, and sending the refreshed value would
    // let the server accept the very lost update the guard rejects.
    await submitConfigPatch(formRevision);
  }

  /**
   * The operator read the conflict and chose their draft anyway. Saves against
   * the current server revision and re-pins the draft to it, so this is a
   * deliberate one-click override rather than a state the only reload clears.
   */
  async function overrideSaveConflict(event: FormEvent) {
    event.preventDefault();
    rebaseFormRevision();
    await submitConfigPatch(config?.revision);
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
    receiveOAuthConfig: applyRemoteConfig,
    overrideSaveConflict,
    restoreLinkedMode,
    saveConfig,
    saveConflict,
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
