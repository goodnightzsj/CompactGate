import { type Dispatch, type FormEvent, type SetStateAction, useRef, useState } from "react";
import type {
  CompactGateConfig,
  ConfigProfileScope,
  PublicConfig
} from "../../shared/types.js";
import {
  applyDraftToConfigExport,
  formAfterConfigConflict,
  formAfterConfigImport,
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
  formBaseline,
  commitConfig,
  applyWrittenConfig,
  applyProfileConfig,
  setConfig,
  setForm,
  refreshHealthAfterWrite
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  linkedCompactModel: string;
  draftRevision: number;
  formRevision: string | null;
  formBaseline: PublicConfig | null;
  commitConfig: (config: PublicConfig, submittedRevision: number) => Promise<void>;
  applyWrittenConfig: (config: PublicConfig) => Promise<void>;
  applyProfileConfig: (config: PublicConfig, scope: ConfigProfileScope) => Promise<void>;
  setConfig: (config: PublicConfig, form?: SetStateAction<ConfigFormState>) => Promise<void>;
  setForm: Dispatch<SetStateAction<ConfigFormState>>;
  refreshHealthAfterWrite: () => Promise<void>;
}) {
  const routePreview = useRoutePreviewAction(config?.revision ?? null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportRequest = useRef(0);
  const exportWithDraft = useRef(true);
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
    applyProfileConfig,
    refreshHealthAfterWrite,
    setSaveError,
    setSaveState,
    scopedProfileAccessors
  });
  const collectionActions = createConfigProfileCollectionActions({
    config,
    profileDeleteCandidate,
    onConfigChange: applyWrittenConfig,
    setProfileDeleteCandidate,
    scopedProfileAccessors
  });

  async function exportConfig(includeDraft = true) {
    if (!config) {
      return;
    }
    const request = ++exportRequest.current;
    exportWithDraft.current = includeDraft;

    try {
      if (includeDraft && !formRevision) throw new Error("草稿版本尚未就绪，请重新加载配置后再导出。");
      const query = includeDraft ? `?revision=${encodeURIComponent(formRevision!)}` : "";
      const savedConfig = await api<CompactGateConfig>(`/api/config/export${query}`);
      const payload = includeDraft ? applyDraftToConfigExport(savedConfig, form) : savedConfig;
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "compactgate.json";
      link.click();
      URL.revokeObjectURL(url);
      if (request === exportRequest.current) setExportError(null);
    } catch (error) {
      if (request !== exportRequest.current) return;
      const summary = errorSummary(error);
      setExportError(/superseded revision/i.test(summary)
        ? "配置已在其他页面或调度中更新，未导出混合版本。请先处理草稿冲突，或选择“仅导出已保存配置”。"
        : summary);
    }
  }

  async function importConfig(payload: unknown) {
    const submittedDraft = form;
    const nextConfig = await api<PublicConfig>("/api/config/import", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    // Import replaces the baseline, unlike a patch of this form's own values.
    await setConfig(nextConfig, (current) => formAfterConfigImport(current, submittedDraft, nextConfig));
    setSaveError(null);
    setSaveConflict(false);
    setSaveState("idle");
    // The follow-up owns clearing prior errors together with its health result.
    await refreshHealthAfterWrite();
  }

  async function submitConfigPatch(revision: string | null | undefined, resolveConflict = false) {
    const submittedRevision = draftRevision;
    setSaveState("saving");
    setSaveError(null);
    setSaveConflict(false);

    try {
      const submittedForm = resolveConflict && formBaseline && config
        ? formAfterConfigConflict(form, formBaseline, config) : form;
      if (submittedForm.importConnectionConflict) setForm(current => ({ ...current, importConnectionConflict: true }));
      const nextConfig = await api<PublicConfig>("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ ...formToPatch(submittedForm), revision })
      });
      if (resolveConflict) await setConfig(nextConfig, current => formAfterConfigImport(current, form, nextConfig));
      else await commitConfig(nextConfig, submittedRevision);
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
   * Merge edited fields onto the latest snapshot; only a successful write
   * advances the baseline that owns omitted credentials.
   */
  async function overrideSaveConflict(event: FormEvent) {
    event.preventDefault();
    if (config && formBaseline) await submitConfigPatch(config.revision, true);
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
    exportError,
    exportSavedConfig: () => exportConfig(false),
    retryExport: () => exportConfig(exportWithDraft.current),
    importConfig,
    profileDeleteCandidate,
    profileError,
    profileName,
    profileState,
    receiveOAuthConfig: applyWrittenConfig,
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
