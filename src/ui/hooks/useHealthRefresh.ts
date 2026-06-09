import { useEffect, useState } from "react";
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

  async function refreshHealth() {
    setIsRefreshingHealth(true);

    try {
      const nextHealth = await api<HealthResponse>("/api/health");
      setHealth(nextHealth);
      setPageError(null);
    } catch (error) {
      setPageError(errorSummary(error));
    } finally {
      setIsRefreshingHealth(false);
    }
  }

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const interval = window.setInterval(async () => {
      try {
        const nextHealth = await api<HealthResponse>("/api/health");
        setHealth(nextHealth);
        setPageError(null);
      } catch (error) {
        setPageError(errorSummary(error));
      }
    }, 4000);

    return () => window.clearInterval(interval);
  }, [enabled, setHealth, setPageError]);

  return {
    isRefreshingHealth,
    refreshHealth
  };
}
