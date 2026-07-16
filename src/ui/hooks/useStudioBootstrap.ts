import { useCallback, useEffect, useReducer, useState } from "react";
import type { HealthResponse, PublicConfig } from "../../shared/types.js";
import type { PageMode } from "../app-types.js";
import {
  INITIAL_STUDIO_CONFIG_STATE,
  reduceStudioConfigState
} from "../config/studio-config-state.js";
import { api, errorSummary } from "../shared/api.js";

export function useStudioBootstrap(pageMode: PageMode) {
  const [configState, dispatchConfig] = useReducer(
    reduceStudioConfigState,
    INITIAL_STUDIO_CONFIG_STATE
  );
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const bootstrapScope = studioBootstrapScope(pageMode);
  const healthMode = bootstrapScope === "health";
  const setConfig = useCallback<React.Dispatch<React.SetStateAction<PublicConfig | null>>>(
    (value) => dispatchConfig({ type: "set_config", value }),
    []
  );
  const setForm = useCallback<React.Dispatch<React.SetStateAction<typeof configState.form>>>(
    (value) => dispatchConfig({ type: "set_form", value }),
    []
  );
  const applyRemoteConfig = useCallback((config: PublicConfig) => {
    dispatchConfig({ type: "remote_config", config });
  }, []);
  const commitConfig = useCallback((config: PublicConfig, submittedRevision: number) => {
    dispatchConfig({ type: "commit_config", config, submittedRevision });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        if (healthMode) {
          const nextHealth = await api<HealthResponse>("/api/health");

          if (cancelled) {
            return;
          }

          setHealth(nextHealth);
          setPageError(null);
          return;
        }

        const [nextConfig, nextHealth] = await Promise.all([
          api<PublicConfig>("/api/config"),
          api<HealthResponse>("/api/health")
        ]);

        if (cancelled) {
          return;
        }

        dispatchConfig({ type: "bootstrap", config: nextConfig });
        setHealth(nextHealth);
        setPageError(null);
      } catch (error) {
        if (!cancelled) {
          setPageError(errorSummary(error));
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [bootstrapScope, healthMode]);

  return {
    config: configState.config,
    setConfig,
    health,
    setHealth,
    form: configState.form,
    setForm,
    draftRevision: configState.draftRevision,
    applyRemoteConfig,
    commitConfig,
    pageError,
    setPageError
  };
}

export function studioBootstrapScope(pageMode: PageMode): "health" | "studio" {
  return pageMode === "health" ? "health" : "studio";
}
