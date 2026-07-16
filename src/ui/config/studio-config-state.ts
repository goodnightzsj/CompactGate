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
}

export type StudioConfigAction =
  | { type: "bootstrap"; config: PublicConfig }
  | { type: "set_config"; value: SetStateAction<PublicConfig | null> }
  | { type: "set_form"; value: SetStateAction<ConfigFormState> }
  | { type: "remote_config"; config: PublicConfig }
  | { type: "commit_config"; config: PublicConfig; submittedRevision: number };

export const INITIAL_STUDIO_CONFIG_STATE: StudioConfigState = {
  config: null,
  form: emptyForm(),
  draftRevision: 0
};

export function reduceStudioConfigState(
  state: StudioConfigState,
  action: StudioConfigAction
): StudioConfigState {
  switch (action.type) {
    case "bootstrap":
      return replaceConfigAndForm(state, action.config);
    case "set_config":
      return {
        ...state,
        config: applyStateAction(state.config, action.value)
      };
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

      return {
        ...state,
        config: action.config
      };
    }
    case "commit_config":
      if (state.draftRevision === action.submittedRevision) {
        return replaceConfigAndForm(state, action.config);
      }
      return {
        ...state,
        config: action.config
      };
  }
}

function replaceConfigAndForm(
  state: StudioConfigState,
  config: PublicConfig
): StudioConfigState {
  return {
    config,
    form: formFromConfig(config),
    draftRevision: state.draftRevision + 1
  };
}

function applyStateAction<Value>(current: Value, action: SetStateAction<Value>): Value {
  return typeof action === "function"
    ? (action as (previous: Value) => Value)(current)
    : action;
}
