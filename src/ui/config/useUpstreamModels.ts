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
  const [models, setModels] = useState<string[]>([]);
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [fetchMeta, setFetchMeta] = useState<string | null>(null);
  const loaderRef = useRef<ReturnType<typeof createUpstreamModelsLoader> | null>(null);
  loaderRef.current ??= createUpstreamModelsLoader();
  const loader = loaderRef.current;

  useEffect(() => {
    loader.invalidate();
    setModels([]);
    setFetchState("idle");
    setFetchMeta(null);
  }, [endpoint, loader, sourceKey]);

  async function fetchModels() {
    setFetchState("loading");
    setFetchMeta(null);
    const result = await loader.load(endpoint);
    if (!result) {
      return;
    }

    setModels(result.models);
    setFetchState(result.fetchState);
    setFetchMeta(result.fetchMeta);
  }

  return {
    models,
    fetchState,
    fetchMeta,
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
