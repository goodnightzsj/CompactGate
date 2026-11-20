import type { SetStateAction } from "react";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import {
  emptyForm,
  adoptImportedConnections,
  configConnectionsChanged,
  formAfterConfigConflict,
  formAfterScopedProfileChange,
  formFromConfig,
  isFormDirty
} from "./config-form-state.js";
import type { ConfigFormState } from "./types.js";

export interface StudioConfigState {
  config: PublicConfig | null;
  form: ConfigFormState;
  draftRevision: number;
  /**
   * The `config.revision` the current form was actually built from — not
   * necessarily `config.revision`. A snapshot arriving from elsewhere (another
   * tab's save, a failover profile switch) refreshes the baseline config while
   * a dirty draft survives; sending the refreshed revision would make the
   * server's concurrency guard accept exactly the lost update it exists to
   * reject.
   */
  formRevision: string | null;
  /** Public ancestor for merging an explicit conflict override; contains no secrets. */
  formBaseline: PublicConfig | null;
  /** The page-level banner text, whatever produced it. */
  pageError: string | null;
  /** Health snapshots or explicit errors supersede earlier health refresh results. */
  pageErrorRevision: number;
  /** Complete recovery or explicit operations supersede pending bootstrap errors. */
  bootstrapErrorRevision: number;
  pageErrorSource: "bootstrap" | "health" | "operation" | null;
  /**
   * The banner belongs to a failed bootstrap, so the page may show stale data.
   */
  bootstrapFailed: boolean;
}

export type StudioConfigAction =
  | { type: "bootstrap"; config: PublicConfig; baselineConfig: PublicConfig | null }
  | { type: "set_config"; value: PublicConfig; form?: SetStateAction<ConfigFormState> }
  | { type: "set_form"; value: SetStateAction<ConfigFormState> }
  | { type: "remote_config"; config: PublicConfig }
  | { type: "apply_profile"; config: PublicConfig; scope: ConfigProfileScope; baselineConfig: PublicConfig | null; baselineRevision: string | null }
  | { type: "commit_config"; config: PublicConfig; submittedRevision: number }
  | { type: "config_write_result"; config: PublicConfig; baselineConfig: PublicConfig | null; write?: StudioConfigWrite }
  | { type: "page_load_result"; error: string | null; baselineErrorRevision: number }
  | { type: "health_refresh_result"; error: string | null; baselineErrorRevision: number; afterConfigWrite?: boolean }
  | { type: "set_page_error"; value: SetStateAction<string | null> }
  | { type: "server_recovered"; healthRecovered?: boolean };

export type StudioConfigWrite = Extract<StudioConfigAction, {
  type: "set_config" | "remote_config" | "apply_profile" | "commit_config"
}>;

export const INITIAL_STUDIO_CONFIG_STATE: StudioConfigState = {
  config: null,
  form: emptyForm(),
  draftRevision: 0,
  formRevision: null,
  formBaseline: null,
  pageError: null,
  pageErrorRevision: 0,
  bootstrapErrorRevision: 0,
  pageErrorSource: null,
  bootstrapFailed: false
};

export function reduceStudioConfigState(
  state: StudioConfigState,
  action: StudioConfigAction
): StudioConfigState {
  switch (action.type) {
    case "config_write_result":
      // A snapshot received during reconciliation owns the baseline unless it confirms this same revision.
      if (state.config !== action.baselineConfig && state.config?.revision !== action.config.revision) return state;
      return reduceStudioConfigState(state, action.write ?? { type: "remote_config", config: action.config });
    case "bootstrap":
      // A snapshot or completed write can supersede this request before it returns.
      if (state.config !== action.baselineConfig) return state;
      // The bootstrap effect re-runs on every return from the health page, so
      // this is not necessarily the first load: adopt the fetched config but
      // keep an unsaved draft, exactly as remote_config does.
      if (!state.config || !isFormDirty(state.config, state.form)) {
        return replaceConfigAndForm(state, action.config);
      }

      return adoptBaselineKeepingDraft(state, action.config);
    case "set_config": {
      // Only guarded draft writes and full imports use this action. Metadata
      // operations use remote_config; applying a profile has its own scoped commit.
      const nextConfig = action.value;
      return {
        ...state,
        config: nextConfig,
        formRevision: nextConfig.revision,
        formBaseline: nextConfig,
        ...(action.form ? { form: applyStateAction(state.form, action.form), draftRevision: state.draftRevision + 1 } : {})
      };
    }
    case "set_form": {
      const nextForm = applyStateAction(state.form, action.value);
      const adoptedConnections = state.form.importConnectionConflict && !nextForm.importConnectionConflict && state.config && state.formBaseline;
      return {
        ...state,
        form: adoptedConnections
          ? adoptImportedConnections(formAfterConfigConflict(nextForm, state.formBaseline!, state.config!), state.config!)
          : nextForm,
        ...(adoptedConnections ? { formBaseline: state.config, formRevision: state.config!.revision } : {}),
        draftRevision: state.draftRevision + 1
      };
    }
    case "remote_config": {
      if (!state.config || !isFormDirty(state.config, state.form)) {
        return replaceConfigAndForm(state, action.config);
      }

      return adoptBaselineKeepingDraft(state, action.config);
    }
    case "apply_profile": {
      if (!action.baselineConfig) return replaceConfigAndForm(state, action.config);
      const form = formAfterScopedProfileChange(state.form, action.config, action.scope);
      // Compare with the baseline captured before the request: its own SSE
      // snapshot may arrive first, but applying one scope resolves no other edits.
      const baseline = formAfterScopedProfileChange(formFromConfig(action.baselineConfig), action.config, action.scope);
      const unchangedScope = action.scope === "codex" ? "claude" : "codex";
      const ancestor = state.formBaseline ?? action.baselineConfig;
      const otherConnectionsChanged = unchangedScope === "claude"
        ? ancestor.claude.primary.connection_revision !== action.config.claude.primary.connection_revision ||
          ancestor.claude.compact.connection_revision !== action.config.claude.compact.connection_revision
        : ancestor.primary.connection_revision !== action.config.primary.connection_revision ||
          ancestor.compact.connection_revision !== action.config.compact.connection_revision;
      const hasConflict = action.baselineRevision !== action.baselineConfig.revision || isFormDirty(action.config, baseline) || otherConnectionsChanged;
      return {
        ...state,
        config: action.config,
        form,
        draftRevision: state.draftRevision + 1,
        formRevision: hasConflict && isFormDirty(action.config, form) ? action.baselineRevision : action.config.revision,
        formBaseline: hasConflict && isFormDirty(action.config, form) && state.formBaseline ? {
          ...state.formBaseline,
          ...(action.scope === "codex" ? { primary: action.config.primary, compact: action.config.compact } : { claude: action.config.claude })
        } : action.config
      };
    }
    case "commit_config":
      if (state.draftRevision === action.submittedRevision) {
        return replaceConfigAndForm(state, action.config);
      }
      // Our own patch landed, so the edits made while it was in flight now sit
      // on top of the config it returned.
      return {
        ...state,
        config: action.config,
        formRevision: action.config.revision,
        formBaseline: action.config
      };
    case "page_load_result":
      if (action.baselineErrorRevision !== state.bootstrapErrorRevision) return state;
      return {
        ...state,
        pageError: action.error,
        pageErrorSource: action.error === null ? null : "bootstrap",
        bootstrapFailed: action.error !== null
      };
    case "health_refresh_result":
      // Background probes cannot replace operation errors; a successful write owns its follow-up.
      if (action.baselineErrorRevision !== state.pageErrorRevision ||
        state.pageErrorSource === "operation" && !action.afterConfigWrite) return state;
      return {
        ...state,
        pageError: action.error,
        pageErrorSource: action.error === null ? null : "health",
        pageErrorRevision: state.pageErrorRevision + 1,
        bootstrapErrorRevision: state.bootstrapErrorRevision + 1,
        bootstrapFailed: false
      };
    case "set_page_error": {
      const pageError = applyStateAction(state.pageError, action.value);
      return {
        ...state, pageError, pageErrorSource: pageError === null ? null : "operation",
        pageErrorRevision: state.pageErrorRevision + 1,
        bootstrapErrorRevision: state.bootstrapErrorRevision + 1, bootstrapFailed: false
      };
    }
    case "server_recovered":
      return action.healthRecovered ? clearStaleLoadFailure(state) : state;
  }
}

/**
 * Recovery invalidates pending load errors, even before the first failure arrives.
 * Health errors require a health snapshot; operation errors stay visible.
 */
function clearStaleLoadFailure(state: StudioConfigState): StudioConfigState {
  const clearError = state.bootstrapFailed || state.pageErrorSource === "health";
  return {
    ...state,
    pageError: clearError ? null : state.pageError,
    pageErrorSource: clearError ? null : state.pageErrorSource,
    pageErrorRevision: state.pageErrorRevision + 1,
    bootstrapErrorRevision: state.bootstrapErrorRevision + 1,
    bootstrapFailed: false
  };
}

/**
 * Takes a foreign snapshot as the new baseline while keeping the dirty draft.
 *
 * `formRevision` only stays pinned when the snapshot actually moves something the
 * form covers, because only then could saving the draft clobber someone's edit.
 * An already conflicted draft remains pinned across later metadata-only updates.
 * Pinning on every snapshot dead-ended the page: `revision` embeds the process
 * boot time, so a proxy restart changes the string wholesale even though the
 * config on disk is byte-identical to what the tab already holds, and the save
 * would then be refused forever with no in-app way back.
 */
function adoptBaselineKeepingDraft(
  state: StudioConfigState,
  config: PublicConfig
): StudioConfigState {
  const touchesForm = state.config
    ? isFormDirty(config, formFromConfig(state.config)) || configConnectionsChanged(state.config, config)
    : true;
  const alreadyConflicted = state.config !== null && state.formRevision !== state.config.revision;
  return {
    ...state,
    config,
    formRevision: touchesForm || alreadyConflicted ? state.formRevision : config.revision,
    formBaseline: touchesForm || alreadyConflicted ? state.formBaseline : config
  };
}

function replaceConfigAndForm(
  state: StudioConfigState,
  config: PublicConfig
): StudioConfigState {
  return {
    ...state,
    config,
    form: formFromConfig(config),
    draftRevision: state.draftRevision + 1,
    formRevision: config.revision,
    formBaseline: config
  };
}

function applyStateAction<Value>(current: Value, action: SetStateAction<Value>): Value {
  return typeof action === "function"
    ? (action as (previous: Value) => Value)(current)
    : action;
}
