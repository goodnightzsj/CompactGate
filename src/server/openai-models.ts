import type { CompactGateConfig } from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";
import { buildUpstreamHeaders } from "./http-utils.js";
import {
  fetchUpstreamModels,
  type UpstreamModelsResponse
} from "./upstream-models.js";

export type OpenAiModelsResponse = UpstreamModelsResponse;

export type FetchOpenAiModels = (config: CompactGateConfig) => Promise<OpenAiModelsResponse>;

export async function fetchOpenAiModels(config: CompactGateConfig): Promise<OpenAiModelsResponse> {
  const credential = resolveRouteCredential("primary", config);
  return fetchUpstreamModels({
    baseUrl: config.primary.base_url,
    headers: buildUpstreamHeaders({}, credential.apiKey),
    timeoutMs: config.timeouts.primary_ms
  });
}
