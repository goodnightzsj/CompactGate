import { useCallback, useEffect, useRef, useState } from "react";
import type { HealthResponse } from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";

export function useHealthRefresh({
  enabled,
  setHealth,
  setPageError
}: {
  enabled: boolean;
  setHealth: React.Dispatch<React.SetStateAction<HealthResponse | null>>;
  setPageError: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const [isRefreshingHealth, setIsRefreshingHealth] = useState(false);
  // Overlapping probes used to write the panel in settle order, so the board
  // could end up on the older of two snapshots. Every probe takes a sequence
  // number and only the newest one is allowed to write.
  const requestIdRef = useRef(0);
  // The button is busy until every manual refresh it started has settled; a
  // single shared boolean let the first response re-enable it while the second
  // was still in flight.
  const inFlightRefreshesRef = useRef(0);

  const loadHealth = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    try {
      const nextHealth = await api<HealthResponse>("/api/health");
      if (requestId !== requestIdRef.current) {
        return;
      }

      setHealth(nextHealth);
      setPageError(null);
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setPageError(errorSummary(error));
      }
    }
  }, [setHealth, setPageError]);

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
    if (!enabled) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadHealth();
    }, 4000);

    return () => window.clearInterval(interval);
  }, [enabled, loadHealth]);

  return {
    isRefreshingHealth,
    refreshHealth
  };
}
