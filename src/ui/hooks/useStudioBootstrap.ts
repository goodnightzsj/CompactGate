import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ClientIdentityStatus, ConfigProfileScope, HealthResponse, PublicConfig } from "../../shared/types.js";
import type { PageMode } from "../app-types.js";
import {
  INITIAL_STUDIO_CONFIG_STATE,
  reduceStudioConfigState,
  type StudioConfigWrite
} from "../config/studio-config-state.js";
import { api, errorSummary } from "../shared/api.js";
import { mergeRefreshedHealth } from "./useHealthRefresh.js";

export function useStudioBootstrap(pageMode: PageMode) {
  const [configState, dispatchConfig] = useReducer(
    reduceStudioConfigState,
    INITIAL_STUDIO_CONFIG_STATE
  );
  const [health, updateHealth] = useState<HealthResponse | null>(null);
  const latestHealth = useRef<HealthResponse | null>(null);
  const healthRevision = useRef(0);
  const setHealth = useCallback<React.Dispatch<React.SetStateAction<HealthResponse | null>>>(value => {
    healthRevision.current += 1;
    latestHealth.current = typeof value === "function" ? value(latestHealth.current) : value;
    updateHealth(latestHealth.current);
  }, []);
  const setCodexStatus = useCallback((codex: HealthResponse["codex"]) => {
    if (latestHealth.current) {
      latestHealth.current = { ...latestHealth.current, codex };
      updateHealth(latestHealth.current);
    }
  }, []);
  const setClientIdentity = useCallback(async (status: ClientIdentityStatus, baseline: ClientIdentityStatus | null) => {
    // Invalidate reads started before this confirmed write, including during React batching.
    const revision = ++healthRevision.current;
    if (latestHealth.current?.client_identity === baseline) {
      setHealth(current => current && { ...current, client_identity: status });
      return;
    }
    let currentStatus: ClientIdentityStatus;
    try { currentStatus = await api<ClientIdentityStatus>("/api/client-identity"); }
    catch (error) {
      throw new Error(`UA 设置已写入，但最新状态刷新失败：${errorSummary(error)}。请刷新状态，无需重复保存。`, { cause: error });
    }
    if (healthRevision.current === revision) setHealth(current => current && { ...current, client_identity: currentStatus });
  }, [setHealth]);
  const [reloadToken, setReloadToken] = useState(0);
  const latestConfig = useRef(configState.config);
  latestConfig.current = configState.config;
  const needsBootstrapRecovery = useRef(false);
  needsBootstrapRecovery.current = configState.bootstrapFailed || (!configState.config && configState.pageErrorSource !== "operation");
  const bootstrapPending = useRef(false);
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
  // Log recovery can trigger a real reload; only matching data clears its error.
  const notifyServerRecovered = useCallback((healthRecovered = false) => {
    if (healthRecovered) dispatchConfig({ type: "server_recovered", healthRecovered });
    else if (needsBootstrapRecovery.current && !bootstrapPending.current) {
      bootstrapPending.current = true;
      retryBootstrap();
    }
  }, [retryBootstrap]);
  const applyHealthRefreshResult = useCallback((error: string | null, baselineErrorRevision: number, afterConfigWrite = false) => {
    dispatchConfig({ type: "health_refresh_result", error, baselineErrorRevision, afterConfigWrite });
  }, []);
  const applyConfigWrite = useCallback(async (config: PublicConfig, write: StudioConfigWrite) => {
    const baselineConfig = latestConfig.current;
    if (baselineConfig?.revision === configState.config?.revision || baselineConfig?.revision === config.revision) {
      latestConfig.current = config;
      dispatchConfig({ type: "config_write_result", config, baselineConfig, write });
      return;
    }
    // Revisions are opaque: a changed baseline requires a fresh read, not string ordering.
    let current: PublicConfig;
    try { current = await api<PublicConfig>("/api/config"); }
    catch (error) { throw new Error(`配置已写入，但最新配置刷新失败：${errorSummary(error)}`, { cause: error }); }
    if (latestConfig.current === baselineConfig || latestConfig.current?.revision === current.revision) latestConfig.current = current;
    dispatchConfig({ type: "config_write_result", config: current, baselineConfig,
      ...(current.revision === config.revision ? { write } : {}) });
  }, [configState.config]);
  const setConfig = useCallback((value: PublicConfig, form?: React.SetStateAction<typeof configState.form>) =>
    applyConfigWrite(value, { type: "set_config", value, form }), [applyConfigWrite]);
  const setForm = useCallback<React.Dispatch<React.SetStateAction<typeof configState.form>>>(
    (value) => dispatchConfig({ type: "set_form", value }),
    []
  );
  const applyRemoteConfig = useCallback((config: PublicConfig) => {
    // Receive order must survive React batching before the reducer renders.
    latestConfig.current = config;
    dispatchConfig({ type: "remote_config", config });
  }, []);
  const applyWrittenConfig = useCallback((config: PublicConfig) =>
    applyConfigWrite(config, { type: "remote_config", config }), [applyConfigWrite]);
  const applyProfileConfig = useCallback((config: PublicConfig, scope: ConfigProfileScope) =>
    applyConfigWrite(config, { type: "apply_profile", config, scope, baselineConfig: configState.config, baselineRevision: configState.formRevision }),
  [applyConfigWrite, configState.config, configState.formRevision]);
  const commitConfig = useCallback((config: PublicConfig, submittedRevision: number) =>
    applyConfigWrite(config, { type: "commit_config", config, submittedRevision }), [applyConfigWrite]);

  useEffect(() => {
    const controller = new AbortController();
    bootstrapPending.current = true;
    const baselineErrorRevision = configState.bootstrapErrorRevision;
    const baselineHealthRevision = healthRevision.current;
    const errors: string[] = [];
    let pending = healthMode ? 1 : 2;
    async function load<Data>(url: string, apply: (data: Data) => void) {
      try {
        const data = await api<Data>(url, { signal: controller.signal });
        if (!controller.signal.aborted) apply(data);
      } catch (error) {
        if (!controller.signal.aborted) {
          errors.push(errorSummary(error));
          dispatchConfig({ type: "page_load_result", error: errors.join("; "), baselineErrorRevision });
        }
      } finally {
        pending -= 1;
        if (!controller.signal.aborted && pending === 0) bootstrapPending.current = false;
        // A late success must neither erase a sibling failure nor replay one already recovered.
        if (!controller.signal.aborted && pending === 0 && errors.length === 0) {
          dispatchConfig({ type: "page_load_result", error: null, baselineErrorRevision });
        }
      }
    }

    if (!healthMode) void load<PublicConfig>("/api/config", (config) => {
      if (latestConfig.current !== configState.config) return;
      // Record accepted reads before a batched write response chooses its baseline.
      latestConfig.current = config;
      dispatchConfig({ type: "bootstrap", config, baselineConfig: configState.config });
    });
    void load<HealthResponse>("/api/health", nextHealth => {
      if (healthRevision.current === baselineHealthRevision) setHealth(current => mergeRefreshedHealth(current, health, nextHealth));
    });
    return () => { controller.abort(); bootstrapPending.current = false; };
    // `healthMode` is derived from `bootstrapScope`, so listing it again would
    // only suggest the two can move independently.
    // Capture data and error ownership at request start without restarting on state changes.
  }, [bootstrapScope, reloadToken]);

  return {
    config: configState.config,
    setConfig,
    health,
    setHealth,
    healthRevision,
    setCodexStatus,
    setClientIdentity,
    applyHealthRefreshResult,
    pageErrorRevision: configState.pageErrorRevision,
    form: configState.form,
    setForm,
    draftRevision: configState.draftRevision,
    formRevision: configState.formRevision,
    formBaseline: configState.formBaseline,
    applyRemoteConfig,
    applyWrittenConfig,
    applyProfileConfig,
    commitConfig,
    notifyServerRecovered,
    pageError: configState.pageError,
    setPageError,
    retryBootstrap,
    bootstrapFailed: configState.bootstrapFailed
  };
}

export function studioBootstrapScope(pageMode: PageMode): "health" | "studio" {
  return pageMode === "health" ? "health" : "studio";
}
