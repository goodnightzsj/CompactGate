import { useEffect, useRef, useState } from "react";
import { api, errorSummary } from "../shared/api.js";

export type UpstreamModelsResponse = {
  models: string[];
  upstream_host: string;
  error: string | null;
};

export type UpstreamModelsLoadResult = {
  models: string[];
  fetchState: "loaded" | "error";
  fetchMeta: string;
};

type FetchModels = (endpoint: string) => Promise<UpstreamModelsResponse>;

const EMPTY_CATALOGUE = { models: [] as string[], fetchState: "idle" as const, fetchMeta: null };

export function createUpstreamModelsLoader(
  fetchModels: FetchModels = (endpoint) => api<UpstreamModelsResponse>(endpoint)
) {
  let requestSequence = 0;

  return {
    invalidate(): void {
      requestSequence += 1;
    },
    async load(endpoint: string): Promise<UpstreamModelsLoadResult | null> {
      const requestId = ++requestSequence;

      try {
        const payload = await fetchModels(endpoint);
        if (requestId !== requestSequence) {
          return null;
        }

        return {
          models: payload.models,
          fetchState: payload.error ? "error" : "loaded",
          fetchMeta: formatFetchResult(payload)
        };
      } catch (error) {
        if (requestId !== requestSequence) {
          return null;
        }

        const message = errorSummary(error);
        return {
          models: [],
          fetchState: "error",
          fetchMeta: message === "API endpoint not found."
            ? "后端模型接口尚未加载，请重启 CompactGate 服务后重试。"
            : message
        };
      }
    }
  };
}

export function useUpstreamModels(endpoint: string, sourceKey: string) {
  const catalogueKey = `${endpoint}\n${sourceKey}`;
  const [catalogue, setCatalogue] = useState<{
    key: string; models: string[]; fetchState: "idle" | "loading" | "loaded" | "error"; fetchMeta: string | null;
  }>({ key: catalogueKey, ...EMPTY_CATALOGUE });
  const loaderRef = useRef<ReturnType<typeof createUpstreamModelsLoader> | null>(null);
  loaderRef.current ??= createUpstreamModelsLoader();
  const loader = loaderRef.current;

  useEffect(() => {
    loader.invalidate();
    // Discard the old state so A -> B -> A cannot revive data or a canceled load.
    setCatalogue({ key: catalogueKey, ...EMPTY_CATALOGUE });
    return () => loader.invalidate();
  }, [catalogueKey, loader]);

  // Hide a previous source synchronously, including before effect cleanup or
  // when an obsolete request resolves in the same commit as a source change.
  const current = catalogue.key === catalogueKey ? catalogue : EMPTY_CATALOGUE;

  async function fetchModels() {
    setCatalogue({ key: catalogueKey, models: current.models, fetchState: "loading", fetchMeta: null });
    const result = await loader.load(endpoint);
    if (!result) {
      return;
    }

    setCatalogue({ key: catalogueKey, ...result });
  }

  return {
    models: current.models,
    fetchState: current.fetchState,
    fetchMeta: current.fetchMeta,
    fetchModels
  };
}

function formatFetchResult(payload: UpstreamModelsResponse): string {
  const upstream = payload.upstream_host || "当前上游";
  if (payload.error) {
    return `${upstream}: ${payload.error}`;
  }

  return payload.models.length > 0
    ? `已从 ${upstream} 读取 ${payload.models.length} 个模型。`
    : `${upstream} 没有返回可用模型。`;
}
