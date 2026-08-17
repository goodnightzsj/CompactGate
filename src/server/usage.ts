import type { IncomingHttpHeaders } from "node:http";
import type { RequestTransport } from "../shared/types.js";
import { mergeUsage } from "./usage-merge.js";
import { extractUsageFromJsonText } from "./usage-record.js";
import type { TokenUsageMetrics } from "./usage-types.js";
import {
  decodeResponseText,
  readHeader
} from "./usage-utils.js";

export type { RequestMetadata, TokenUsageMetrics } from "./usage-types.js";
export { extractResponseErrorSummary } from "./usage-error.js";
export {
  extractRequestMetadata,
  extractSourceModel
} from "./usage-request.js";
import { sseDataFrames } from "./sse-frames.js";

const EMPTY_USAGE = emptyUsageMetrics();

export function emptyUsageMetrics(): TokenUsageMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cachedOutputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    reasoningTokens: null,
    totalTokens: null
  };
}

export function responseTransport(headers: IncomingHttpHeaders): RequestTransport | null {
  const contentType = readHeader(headers["content-type"]);
  return contentType?.toLowerCase().includes("text/event-stream") ? "stream" : null;
}

export function extractResponseUsage(
  responseBody: Buffer,
  headers: IncomingHttpHeaders = {}
): TokenUsageMetrics {
  if (responseBody.byteLength === 0) {
    return EMPTY_USAGE;
  }

  const text = decodeResponseText(responseBody, headers);
  if (!text) {
    return EMPTY_USAGE;
  }

  const contentType = readHeader(headers["content-type"])?.toLowerCase() ?? "";
  const usage = contentType.includes("text/event-stream")
    ? extractSseUsage(text)
    : extractUsageFromJsonText(text);

  return usage ?? EMPTY_USAGE;
}

export function hasTokenUsage(usage: TokenUsageMetrics | null | undefined): boolean {
  if (!usage) {
    return false;
  }

  return (
    usage.inputTokens !== null ||
    usage.outputTokens !== null ||
    usage.cachedInputTokens !== null ||
    usage.cachedOutputTokens !== null ||
    usage.cacheReadInputTokens !== null ||
    usage.cacheCreationInputTokens !== null ||
    usage.reasoningTokens !== null ||
    usage.totalTokens !== null
  );
}

function extractSseUsage(text: string): TokenUsageMetrics | null {
  let latestUsage: TokenUsageMetrics | null = null;

  for (const data of sseDataFrames(text)) {
    const usage = extractUsageFromJsonText(data);
    if (usage) {
      latestUsage = mergeUsage(latestUsage, usage);
    }
  }

  return latestUsage;
}
