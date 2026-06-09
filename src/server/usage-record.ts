import type { TokenUsageMetrics } from "./usage-types.js";
import {
  isRecord,
  readFirstNumber,
  readNestedNumber,
  readNumber
} from "./usage-utils.js";
import {
  sumNullableNumberList,
  usageTotalFloor
} from "./usage-merge.js";

export function extractUsageFromJsonText(text: string): TokenUsageMetrics | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const usage = findUsageRecord(parsed);
    return usage ? normalizeUsageRecord(usage) : null;
  } catch {
    return null;
  }
}

function normalizeUsageRecord(usage: Record<string, unknown>): TokenUsageMetrics {
  const reasoningTokens = readReasoningTokens(usage);
  const inputTokens = readInputTokens(usage);
  const outputTokens = readOutputTokens(usage, reasoningTokens);
  const cacheReadInputTokens = readCacheReadInputTokens(usage);
  const cacheCreationInputTokens = sumNullableNumberList([
    readCacheCreationInputTokens(usage),
    readAnthropicCacheCreationInputTokens(usage.cache_creation)
  ]);
  const additiveCachedInputTokens = sumNullableNumberList([
    cacheReadInputTokens,
    cacheCreationInputTokens
  ]);
  const additiveCachedOutputTokens = readFirstNumber(usage, [
    "cache_read_output_tokens",
    "cache_read_output",
    "output_cache_read_tokens"
  ]);
  const cachedInputTokens =
    readNestedNumber(usage.input_tokens_details, "cached_tokens") ??
    readNestedNumber(usage.prompt_tokens_details, "cached_tokens") ??
    readNestedNumber(usage.inputTokensDetails, "cachedTokens") ??
    readNestedNumber(usage.promptTokensDetails, "cachedTokens") ??
    readFirstNumber(usage, [
      "prompt_cache_hit_tokens",
      "cachedContentTokenCount",
      "cached_content_token_count",
      "cached_input_tokens",
      "cached_tokens"
    ]) ??
    readNumber(usage.cached_tokens) ??
    additiveCachedInputTokens;
  const cachedOutputTokens =
    readNestedNumber(usage.output_tokens_details, "cached_tokens") ??
    readNestedNumber(usage.completion_tokens_details, "cached_tokens") ??
    readNestedNumber(usage.outputTokensDetails, "cachedTokens") ??
    readNestedNumber(usage.completionTokensDetails, "cachedTokens") ??
    readFirstNumber(usage, [
      "completion_cache_hit_tokens",
      "cached_output_tokens"
    ]) ??
    additiveCachedOutputTokens;
  const inputCacheIsAdditive = additiveCachedInputTokens !== null;
  const outputCacheIsAdditive = additiveCachedOutputTokens !== null;
  const totalFloor = usageTotalFloor({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cachedOutputTokens,
    additiveCachedInputTokens: inputCacheIsAdditive,
    additiveCachedOutputTokens: outputCacheIsAdditive
  });
  const explicitTotal = readFirstNumber(usage, ["total_tokens", "totalTokens", "totalTokenCount"]);
  const totalTokens = explicitTotal !== null && totalFloor !== null
    ? Math.max(explicitTotal, totalFloor)
    : explicitTotal ?? totalFloor;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cachedOutputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
    totalTokens,
    additiveCachedInputTokens: inputCacheIsAdditive,
    additiveCachedOutputTokens: outputCacheIsAdditive
  };
}

function readInputTokens(usage: Record<string, unknown>): number | null {
  const direct = readFirstNumber(usage, [
    "input_tokens",
    "prompt_tokens",
    "inputTokens",
    "promptTokens",
    "promptTokenCount"
  ]);
  if (direct !== null) {
    return direct;
  }

  return sumNullableNumberList([
    readFirstNumber(usage, ["prompt_cache_hit_tokens", "cachedContentTokenCount", "cached_content_token_count"]),
    readFirstNumber(usage, ["prompt_cache_miss_tokens", "prompt_cache_miss_input_tokens"])
  ]);
}

function readOutputTokens(usage: Record<string, unknown>, reasoningTokens: number | null): number | null {
  const candidateTokens = readFirstNumber(usage, ["candidatesTokenCount", "candidate_tokens"]);
  if (candidateTokens !== null && reasoningTokens !== null) {
    return candidateTokens + reasoningTokens;
  }

  return readFirstNumber(usage, [
    "output_tokens",
    "completion_tokens",
    "outputTokens",
    "completionTokens",
    "candidatesTokenCount"
  ]);
}

function readCacheReadInputTokens(usage: Record<string, unknown>): number | null {
  return readFirstNumber(usage, [
    "cache_read_input_tokens",
    "cache_read_tokens",
    "cacheReadInputTokens",
    "cacheReadTokens",
    "input_cache_read_tokens"
  ]);
}

function readCacheCreationInputTokens(usage: Record<string, unknown>): number | null {
  return sumNullableNumberList([
    readFirstNumber(usage, [
      "cache_creation_input_tokens",
      "cache_creation_tokens",
      "cache_write_tokens",
      "cacheCreationInputTokens",
      "cacheCreationTokens",
      "cacheWriteTokens",
      "input_cache_creation_tokens"
    ]),
    readFirstNumber(usage, [
      "cache_creation_5m_tokens",
      "cache_creation_1h_tokens",
      "cache_creation_5m_input_tokens",
      "cache_creation_1h_input_tokens"
    ])
  ]);
}

function readAnthropicCacheCreationInputTokens(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  return sumNullableNumberList([
    readNumber(value.ephemeral_5m_input_tokens),
    readNumber(value.ephemeral_1h_input_tokens),
    readNumber(value.ephemeral5mInputTokens),
    readNumber(value.ephemeral1hInputTokens)
  ]);
}

function readReasoningTokens(usage: Record<string, unknown>): number | null {
  return readNestedNumber(usage.output_tokens_details, "reasoning_tokens") ??
    readNestedNumber(usage.completion_tokens_details, "reasoning_tokens") ??
    readNestedNumber(usage.output_tokens_details, "thinking_tokens") ??
    readNestedNumber(usage.completion_tokens_details, "thinking_tokens") ??
    readNestedNumber(usage.outputTokensDetails, "reasoningTokens") ??
    readNestedNumber(usage.completionTokensDetails, "reasoningTokens") ??
    readNestedNumber(usage.outputTokensDetails, "thinkingTokens") ??
    readNestedNumber(usage.completionTokensDetails, "thinkingTokens") ??
    readFirstNumber(usage, [
      "reasoning_output_tokens",
      "reasoning_tokens",
      "reasoningTokens",
      "thinking_tokens",
      "thinkingTokens",
      "thoughtsTokenCount",
      "thoughtTokens"
    ]);
}

function findUsageRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!isRecord(value) || depth > 4) {
    return null;
  }

  if (isRecord(value.usage)) {
    return value.usage;
  }

  if (isRecord(value.usageMetadata)) {
    return value.usageMetadata;
  }

  if (looksLikeUsageRecord(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findUsageRecord(item, depth + 1);
        if (found) {
          return found;
        }
      }
      continue;
    }

    const found = findUsageRecord(child, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function looksLikeUsageRecord(value: Record<string, unknown>): boolean {
  return [
    "input_tokens",
    "prompt_tokens",
    "output_tokens",
    "completion_tokens",
    "total_tokens",
    "inputTokens",
    "promptTokens",
    "outputTokens",
    "completionTokens",
    "totalTokens",
    "promptTokenCount",
    "candidatesTokenCount",
    "totalTokenCount",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "prompt_cache_hit_tokens",
    "cachedContentTokenCount",
    "thoughtsTokenCount"
  ].some((key) => Object.hasOwn(value, key));
}
