import type { SetStateAction } from "react";
import type { PublicConfig } from "../../shared/types.js";
import {
  emptyForm,
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
}

export type StudioConfigAction =
  | { type: "bootstrap"; config: PublicConfig }
  | { type: "set_config"; value: SetStateAction<PublicConfig | null> }
  | { type: "set_form"; value: SetStateAction<ConfigFormState> }
  | { type: "remote_config"; config: PublicConfig }
  | { type: "rebase_form_revision" }
  | { type: "commit_config"; config: PublicConfig; submittedRevision: number };

export const INITIAL_STUDIO_CONFIG_STATE: StudioConfigState = {
  config: null,
  form: emptyForm(),
  draftRevision: 0,
  formRevision: null
};

export function reduceStudioConfigState(
  state: StudioConfigState,
  action: StudioConfigAction
): StudioConfigState {
  switch (action.type) {
    case "bootstrap":
      // The bootstrap effect re-runs on every return from the health page, so
      // this is not necessarily the first load: adopt the fetched config but
      // keep an unsaved draft, exactly as remote_config does.
      if (!state.config || !isFormDirty(state.config, state.form)) {
        return replaceConfigAndForm(state, action.config);
      }

      return adoptBaselineKeepingDraft(state, action.config);
    case "set_config": {
      // Every dispatcher of this action is one of this tab's own successful
      // writes, so the draft it left behind really does sit on top of the
      // returned config: adopting the revision keeps follow-up saves working.
      const nextConfig = applyStateAction(state.config, action.value);
      return {
        ...state,
        config: nextConfig,
        formRevision: nextConfig?.revision ?? state.formRevision
      };
    }
    case "set_form": {
      const nextForm = applyStateAction(state.form, action.value);
      return {
        ...state,
        form: nextForm,
        draftRevision: state.draftRevision + 1
      };
    }
    case "remote_config": {
      if (!state.config || !isFormDirty(state.config, state.form)) {
        return replaceConfigAndForm(state, action.config);
      }

      return adoptBaselineKeepingDraft(state, action.config);
    }
    case "rebase_form_revision":
      // The operator saw the conflict and chose to keep their draft anyway. Only
      // reachable from the save bar's explicit override, so the next save carries
      // the current revision and lands.
      return state.config
        ? { ...state, formRevision: state.config.revision }
        : state;
    case "commit_config":
      if (state.draftRevision === action.submittedRevision) {
        return replaceConfigAndForm(state, action.config);
      }
      // Our own patch landed, so the edits made while it was in flight now sit
      // on top of the config it returned.
      return {
        ...state,
        config: action.config,
        formRevision: action.config.revision
      };
  }
}

/**
 * Takes a foreign snapshot as the new baseline while keeping the dirty draft.
 *
 * `formRevision` only stays pinned when the snapshot actually moves something the
 * form covers, because only then could saving the draft clobber someone's edit.
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
    ? isFormDirty(config, formFromConfig(state.config))
    : true;
  return {
    ...state,
    config,
    formRevision: touchesForm ? state.formRevision : config.revision
  };
}

function replaceConfigAndForm(
  state: StudioConfigState,
  config: PublicConfig
): StudioConfigState {
  return {
    config,
    form: formFromConfig(config),
    draftRevision: state.draftRevision + 1,
    formRevision: config.revision
  };
}

function applyStateAction<Value>(current: Value, action: SetStateAction<Value>): Value {
  return typeof action === "function"
    ? (action as (previous: Value) => Value)(current)
    : action;
}
