import type { TokenUsageMetrics } from "./usage-types.js";

export function mergeUsage(
  previous: TokenUsageMetrics | null,
  next: TokenUsageMetrics
): TokenUsageMetrics {
  if (!previous) {
    return next;
  }

  const inputTokens = mergeRequestScopedTokens(previous.inputTokens, next.inputTokens);
  const outputTokens = next.outputTokens ?? previous.outputTokens;
  const cachedOutputTokens = next.cachedOutputTokens ?? previous.cachedOutputTokens;
  const cacheReadInputTokens = mergeCacheReadInputTokens(previous, next);
  const cacheCreationInputTokens = mergeRequestScopedTokens(
    previous.cacheCreationInputTokens,
    next.cacheCreationInputTokens
  );
  const reasoningTokens = mergeRequestScopedTokens(previous.reasoningTokens, next.reasoningTokens);
  const additiveCachedInputTokens = Boolean(next.additiveCachedInputTokens || previous.additiveCachedInputTokens);
  const additiveCachedOutputTokens = Boolean(next.additiveCachedOutputTokens || previous.additiveCachedOutputTokens);
  const cachedInputTokens = additiveCachedInputTokens
    ? sumNullableNumberList([cacheReadInputTokens, cacheCreationInputTokens]) ?? mergeCachedInputTokens(previous, next)
    : mergeCachedInputTokens(previous, next);
  const totalFloor = usageTotalFloor({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cachedOutputTokens,
    additiveCachedInputTokens,
    additiveCachedOutputTokens
  });
  const explicitTotal = pickUsableTotal(next.totalTokens, previous.totalTokens, totalFloor);

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cachedOutputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
    totalTokens: explicitTotal ?? totalFloor,
    additiveCachedInputTokens,
    additiveCachedOutputTokens
  };
}

function mergeRequestScopedTokens(previous: number | null, next: number | null): number | null {
  if (next === null) {
    return previous;
  }

  if (previous === null) {
    return next;
  }

  return next === 0 && previous > 0 ? previous : next;
}

function mergeCacheReadInputTokens(
  previous: TokenUsageMetrics,
  next: TokenUsageMetrics
): number | null {
  if (next.cacheReadInputTokens === null) {
    return previous.cacheReadInputTokens;
  }

  if (previous.cacheReadInputTokens === null) {
    return next.cacheReadInputTokens;
  }

  const previousNonReadInputTokens = (previous.inputTokens ?? 0) + (previous.cacheCreationInputTokens ?? 0);
  const nextCollapsedInputIntoCache =
    previousNonReadInputTokens > 0 &&
    next.inputTokens === 0 &&
    previous.additiveCachedInputTokens === true &&
    next.additiveCachedInputTokens === true &&
    next.cacheReadInputTokens === previous.cacheReadInputTokens + previousNonReadInputTokens;

  if (nextCollapsedInputIntoCache) {
    return previous.cacheReadInputTokens;
  }

  return next.cacheReadInputTokens === 0 && previous.cacheReadInputTokens > 0
    ? previous.cacheReadInputTokens
    : next.cacheReadInputTokens;
}

function mergeCachedInputTokens(
  previous: TokenUsageMetrics,
  next: TokenUsageMetrics
): number | null {
  if (next.cachedInputTokens === null) {
    return previous.cachedInputTokens;
  }

  if (previous.cachedInputTokens === null) {
    return next.cachedInputTokens;
  }

  const previousInputTokens = previous.inputTokens ?? 0;
  const nextCollapsedInputIntoCache =
    previousInputTokens > 0 &&
    next.inputTokens === 0 &&
    previous.additiveCachedInputTokens === true &&
    next.additiveCachedInputTokens === true &&
    next.cachedInputTokens === previous.cachedInputTokens + previousInputTokens;

  if (nextCollapsedInputIntoCache) {
    return previous.cachedInputTokens;
  }

  return next.cachedInputTokens === 0 && previous.cachedInputTokens > 0
    ? previous.cachedInputTokens
    : next.cachedInputTokens;
}

function pickUsableTotal(
  nextTotal: number | null,
  previousTotal: number | null,
  derivedTotal: number | null
): number | null {
  if (derivedTotal === null) {
    return nextTotal ?? previousTotal;
  }

  if (nextTotal !== null && nextTotal >= derivedTotal) {
    return nextTotal;
  }

  if (previousTotal !== null && previousTotal >= derivedTotal) {
    return previousTotal;
  }

  return null;
}

export function usageTotalFloor(usage: Pick<
  TokenUsageMetrics,
  "inputTokens" | "outputTokens" | "cachedInputTokens" | "cachedOutputTokens" | "additiveCachedInputTokens" | "additiveCachedOutputTokens"
>): number | null {
  if (
    usage.inputTokens === null &&
    usage.outputTokens === null &&
    usage.cachedInputTokens === null &&
    usage.cachedOutputTokens === null
  ) {
    return null;
  }

  return (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.additiveCachedInputTokens ? usage.cachedInputTokens ?? 0 : 0) +
    (usage.additiveCachedOutputTokens ? usage.cachedOutputTokens ?? 0 : 0);
}

export function sumNullableNumberList(values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) {
    return null;
  }

  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
