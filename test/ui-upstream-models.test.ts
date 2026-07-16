import { describe, expect, it } from "vitest";
import {
  createUpstreamModelsLoader,
  type UpstreamModelsResponse
} from "../src/ui/config/useUpstreamModels.js";

describe("upstream model loader", () => {
  it("does not apply a response after its model source is invalidated", async () => {
    let resolveRequest: (payload: UpstreamModelsResponse) => void = () => undefined;
    const response = new Promise<UpstreamModelsResponse>((resolve) => {
      resolveRequest = resolve;
    });
    const loader = createUpstreamModelsLoader(() => response);
    const staleLoad = loader.load("/api/openai/models");

    loader.invalidate();
    resolveRequest({
      models: ["stale-model"],
      upstream_host: "old.example",
      error: null
    });

    await expect(staleLoad).resolves.toBeNull();
  });

  it("returns a visible error state without inventing model options", async () => {
    const loader = createUpstreamModelsLoader(async () => {
      throw new Error("API endpoint not found.");
    });

    await expect(loader.load("/api/openai/models")).resolves.toEqual({
      models: [],
      fetchState: "error",
      fetchMeta: "后端模型接口尚未加载，请重启 CompactGate 服务后重试。"
    });
  });
});
