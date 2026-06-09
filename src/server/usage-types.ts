import type { RequestTransport } from "../shared/types.js";

export interface RequestMetadata {
  endpoint: string;
  requestType: RequestTransport;
  reasoningEffort: string | null;
  requestSummary: string | null;
}

export interface TokenUsageMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cachedOutputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  additiveCachedInputTokens?: boolean;
  additiveCachedOutputTokens?: boolean;
}
