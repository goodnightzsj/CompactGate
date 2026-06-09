import { useEffect, useState } from "react";
import type { HealthResponse, PublicConfig } from "../../shared/types.js";
import type { PageMode } from "../app-types.js";
import { emptyForm, formFromConfig } from "../config/config-form-state.js";
import type { ConfigFormState } from "../config/types.js";
import { api, errorSummary } from "../shared/api.js";

export function useStudioBootstrap(pageMode: PageMode) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [form, setForm] = useState<ConfigFormState>(emptyForm);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        if (pageMode === "health") {
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

        setConfig(nextConfig);
        setHealth(nextHealth);
        setForm(formFromConfig(nextConfig));
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
  }, [pageMode]);

  return {
    config,
    setConfig,
    health,
    setHealth,
    form,
    setForm,
    pageError,
    setPageError
  };
}
