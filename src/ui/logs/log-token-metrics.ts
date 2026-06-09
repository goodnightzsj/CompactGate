import type { RequestLogEntry } from "../../shared/types.js";

export function displayInputTokens(entry: RequestLogEntry): number | null {
  if (entry.input_tokens === null && entry.cache_creation_input_tokens === null) {
    return null;
  }

  return hasAdditiveCachedInput(entry)
    ? (entry.input_tokens ?? 0) + (entry.cache_creation_input_tokens ?? 0)
    : entry.input_tokens;
}

export function cacheReadInputTokens(entry: RequestLogEntry): number | null {
  if (entry.cache_read_input_tokens !== null) {
    return entry.cache_read_input_tokens;
  }

  if (entry.cached_input_tokens === null) {
    return null;
  }

  if (!hasAdditiveCachedInput(entry)) {
    return entry.cached_input_tokens;
  }

  return Math.max(0, entry.cached_input_tokens - (entry.cache_creation_input_tokens ?? 0));
}

export function cacheCreationInputTokens(entry: RequestLogEntry): number | null {
  return hasAdditiveCachedInput(entry) ? entry.cache_creation_input_tokens : null;
}

export function cachedInputTotalTokens(entry: RequestLogEntry): number | null {
  if (entry.cached_input_tokens !== null) {
    return entry.cached_input_tokens;
  }

  const cacheReadTokens = entry.cache_read_input_tokens;
  const cacheCreationTokens = entry.cache_creation_input_tokens;
  if (cacheReadTokens === null && cacheCreationTokens === null) {
    return null;
  }

  return (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0);
}

export function totalInputTokens(entry: RequestLogEntry): number | null {
  if (
    entry.input_tokens === null &&
    entry.cached_input_tokens === null &&
    entry.cache_read_input_tokens === null &&
    entry.cache_creation_input_tokens === null
  ) {
    return null;
  }

  return hasAdditiveCachedInput(entry)
    ? (entry.input_tokens ?? 0) + (cacheReadInputTokens(entry) ?? 0) + (entry.cache_creation_input_tokens ?? 0)
    : entry.input_tokens;
}

export function formatCacheHitRate(entry: RequestLogEntry): string {
  const cachedInputTokens = hasAdditiveCachedInput(entry)
    ? cacheReadInputTokens(entry)
    : entry.cached_input_tokens;
  if (cachedInputTokens === null) {
    return "-";
  }

  const denominator = hasAdditiveCachedInput(entry)
    ? totalInputTokens(entry)
    : entry.input_tokens;
  if (!denominator) {
    return "-";
  }

  const rate = Math.min(100, (cachedInputTokens / denominator) * 100);
  return `${formatPercentRate(rate)}%`;
}

export function displayTotalTokens(entry: RequestLogEntry): number | null {
  const inputTokens = entry.input_tokens ?? 0;
  const outputTokens = entry.output_tokens ?? 0;
  const cachedInputTokens = cachedInputTotalTokens(entry) ?? 0;
  const cachedOutputTokens = entry.cached_output_tokens ?? 0;
  const hasAnyToken =
    entry.input_tokens !== null ||
    entry.output_tokens !== null ||
    entry.cached_input_tokens !== null ||
    entry.cache_read_input_tokens !== null ||
    entry.cache_creation_input_tokens !== null ||
    entry.cached_output_tokens !== null ||
    entry.total_tokens !== null;

  if (!hasAnyToken) {
    return null;
  }

  const floor = inputTokens +
    outputTokens +
    (hasAdditiveCachedInput(entry) ? cachedInputTokens : 0) +
    (hasAdditiveCachedOutput(entry) ? cachedOutputTokens : 0);
  return Math.max(entry.total_tokens ?? 0, floor);
}

export function hasAdditiveCachedInput(entry: RequestLogEntry): boolean {
  return entry.additive_cached_input_tokens ||
    (
      entry.cached_input_tokens !== null &&
      entry.input_tokens !== null &&
      entry.cached_input_tokens > entry.input_tokens
    );
}

export function hasAdditiveCachedOutput(entry: RequestLogEntry): boolean {
  return entry.additive_cached_output_tokens;
}

function formatPercentRate(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value >= 99 ? value.toFixed(2) : value.toFixed(1);
}
