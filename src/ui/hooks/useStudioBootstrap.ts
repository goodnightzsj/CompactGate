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
  const [reloadToken, setReloadToken] = useState(0);
  const bootstrapScope = studioBootstrapScope(pageMode);
  const healthMode = bootstrapScope === "health";
  /**
   * The load effect only re-runs when the bootstrap scope changes, so a failure
   * during a proxy restart left the operator with an error banner, whatever
   * stale data was already rendered, and no way forward but a browser reload.
   */
  const retryBootstrap = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);
  const setPageError = useCallback<React.Dispatch<React.SetStateAction<string | null>>>(
    (value) => dispatchConfig({ type: "set_page_error", value }),
    []
  );
  /**
   * A poll that answers is the other proof the proxy came back — the SSE
   * snapshot path clears the banner through `remote_config`, but the fallback
   * poll carries no config and used to clear only the log-level error.
   */
  const notifyServerRecovered = useCallback(() => {
    dispatchConfig({ type: "server_recovered" });
  }, []);
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
  const rebaseFormRevision = useCallback(() => {
    dispatchConfig({ type: "rebase_form_revision" });
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
          dispatchConfig({ type: "page_load_result", error: null });
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
        dispatchConfig({ type: "page_load_result", error: null });
      } catch (error) {
        if (!cancelled) {
          dispatchConfig({ type: "page_load_result", error: errorSummary(error) });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // `healthMode` is derived from `bootstrapScope`, so listing it again would
    // only suggest the two can move independently.
  }, [bootstrapScope, reloadToken]);

  return {
    config: configState.config,
    setConfig,
    health,
    setHealth,
    form: configState.form,
    setForm,
    draftRevision: configState.draftRevision,
    formRevision: configState.formRevision,
    applyRemoteConfig,
    commitConfig,
    notifyServerRecovered,
    pageError: configState.pageError,
    setPageError,
    retryBootstrap,
    rebaseFormRevision,
    bootstrapFailed: configState.bootstrapFailed
  };
}

export function studioBootstrapScope(pageMode: PageMode): "health" | "studio" {
  return pageMode === "health" ? "health" : "studio";
}
