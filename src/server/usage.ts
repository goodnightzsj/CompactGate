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

const EMPTY_USAGE: TokenUsageMetrics = {
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cachedOutputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  reasoningTokens: null,
  totalTokens: null
};

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

  const text = decodeResponseText(responseBody);
  if (!text) {
    return EMPTY_USAGE;
  }

  const contentType = readHeader(headers["content-type"])?.toLowerCase() ?? "";
  const usage = contentType.includes("text/event-stream")
    ? extractSseUsage(text)
    : extractJsonUsage(text);

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
  const frames = text.split(/\r?\n\r?\n/);

  for (const frame of frames) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());

    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      continue;
    }

    const usage = extractUsageFromJsonText(data);
    if (usage) {
      latestUsage = mergeUsage(latestUsage, usage);
    }
  }

  return latestUsage;
}

function extractJsonUsage(text: string): TokenUsageMetrics | null {
  return extractUsageFromJsonText(text);
}
