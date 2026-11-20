import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HealthResponse } from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";

export function useHealthRefresh({
  enabled,
  health,
  healthRevision,
  pageErrorRevision,
  setHealth,
  applyHealthRefreshResult
}: {
  enabled: boolean;
  health: HealthResponse | null;
  healthRevision: React.RefObject<number>;
  pageErrorRevision: number;
  setHealth: React.Dispatch<React.SetStateAction<HealthResponse | null>>;
  applyHealthRefreshResult: (error: string | null, baselineErrorRevision: number, afterConfigWrite?: boolean) => void;
}) {
  const [isRefreshingHealth, setIsRefreshingHealth] = useState(false);
  // Overlapping probes used to write the panel in settle order, so the board
  // could end up on the older of two snapshots. Every probe takes a sequence
  // number and only the newest one is allowed to write.
  const requestIdRef = useRef(0);
  const snapshotRef = useRef({ health, pageErrorRevision });
  const controllersRef = useRef(new Set<AbortController>());
  useLayoutEffect(() => { snapshotRef.current = { health, pageErrorRevision }; }, [health, pageErrorRevision]);
  // The button is busy until every manual refresh it started has settled; a
  // single shared boolean let the first response re-enable it while the second
  // was still in flight.
  const inFlightRefreshesRef = useRef(0);

  const loadHealth = useCallback(async (afterConfigWrite = false) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const baseline = snapshotRef.current;
    const baselineHealthRevision = healthRevision.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);

    try {
      const nextHealth = await api<HealthResponse>("/api/health", { signal: controller.signal });
      if (controller.signal.aborted || requestId !== requestIdRef.current || healthRevision.current !== baselineHealthRevision) {
        return;
      }

      setHealth(current => mergeRefreshedHealth(current, baseline.health, nextHealth));
      applyHealthRefreshResult(null, baseline.pageErrorRevision, afterConfigWrite);
    } catch (error) {
      if (!controller.signal.aborted && requestId === requestIdRef.current && healthRevision.current === baselineHealthRevision) {
        if (afterConfigWrite) setHealth(null);
        applyHealthRefreshResult(afterConfigWrite
          ? `配置已写入，但健康状态刷新失败：${errorSummary(error)}。请重试状态刷新，无需重复保存。`
          : errorSummary(error), baseline.pageErrorRevision, afterConfigWrite);
      }
    } finally {
      controllersRef.current.delete(controller);
    }
  }, [setHealth, healthRevision, applyHealthRefreshResult]);

  async function refreshHealth() {
    inFlightRefreshesRef.current += 1;
    setIsRefreshingHealth(true);

    try {
      await loadHealth();
    } finally {
      inFlightRefreshesRef.current -= 1;
      if (inFlightRefreshesRef.current === 0) {
        setIsRefreshingHealth(false);
      }
    }
  }

  useEffect(() => {
    let active = enabled;
    let timer: number | undefined;
    const poll = async () => {
      if (controllersRef.current.size === 0) await loadHealth();
      if (active) timer = window.setTimeout(poll, 4000);
    };
    if (active) timer = window.setTimeout(poll, 4000);

    return () => {
      active = false;
      window.clearTimeout(timer);
      requestIdRef.current += 1;
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
    };
  }, [enabled, loadHealth]);

  return {
    isRefreshingHealth,
    refreshHealth,
    refreshHealthAfterWrite: () => loadHealth(true)
  };
}

export function mergeRefreshedHealth(current: HealthResponse | null, baseline: HealthResponse | null, next: HealthResponse): HealthResponse {
  return current && current.codex !== baseline?.codex ? { ...next, codex: current.codex } : next;
}
