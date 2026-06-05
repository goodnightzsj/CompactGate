import { gunzipSync } from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";
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

export function extractRequestMetadata(pathname: string, rawBody: Buffer): RequestMetadata {
  const endpoint = normalizeEndpoint(pathname);
  const parsed = parseJsonRecord(rawBody);

  return {
    endpoint,
    requestType: parsed?.stream === true ? "stream" : "http",
    reasoningEffort: extractReasoningEffort(parsed),
    requestSummary: extractRequestSummary(endpoint, parsed)
  };
}

export function extractSourceModel(rawBody: Buffer): string | null {
  const parsed = parseJsonRecord(rawBody);
  return typeof parsed?.model === "string" && parsed.model.trim().length > 0
    ? parsed.model
    : null;
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

export function extractResponseErrorSummary(
  status: number,
  responseBody: Buffer,
  headers: IncomingHttpHeaders = {}
): string | null {
  if (status < 400) {
    return null;
  }

  const text = decodeResponseText(responseBody);
  if (!text) {
    return `Upstream returned HTTP ${status}.`;
  }

  const contentType = readHeader(headers["content-type"])?.toLowerCase() ?? "";
  const parsedSummary = contentType.includes("json") ? extractJsonErrorSummary(text) : null;
  const summary = parsedSummary ?? text.trim().replace(/\s+/g, " ");

  return summary.length > 0
    ? `Upstream returned HTTP ${status}: ${truncateSummary(summary)}`
    : `Upstream returned HTTP ${status}.`;
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

function mergeUsage(
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

function extractJsonUsage(text: string): TokenUsageMetrics | null {
  return extractUsageFromJsonText(text);
}

function extractUsageFromJsonText(text: string): TokenUsageMetrics | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const usage = findUsageRecord(parsed);
    return usage ? normalizeUsageRecord(usage) : null;
  } catch {
    return null;
  }
}

function normalizeUsageRecord(usage: Record<string, unknown>): TokenUsageMetrics {
  const inputTokens = readNumber(usage.input_tokens) ?? readNumber(usage.prompt_tokens);
  const outputTokens = readNumber(usage.output_tokens) ?? readNumber(usage.completion_tokens);
  const reasoningTokens = readReasoningTokens(usage);
  const cacheReadInputTokens = readNumber(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = sumNullableNumberList([
    readNumber(usage.cache_creation_input_tokens),
    readAnthropicCacheCreationInputTokens(usage.cache_creation)
  ]);
  const additiveCachedInputTokens = sumNullableNumberList([
    cacheReadInputTokens,
    cacheCreationInputTokens
  ]);
  const additiveCachedOutputTokens = readNumber(usage.cache_read_output_tokens);
  const cachedInputTokens =
    readNestedNumber(usage.input_tokens_details, "cached_tokens") ??
    readNestedNumber(usage.prompt_tokens_details, "cached_tokens") ??
    readNumber(usage.cached_tokens) ??
    additiveCachedInputTokens;
  const cachedOutputTokens =
    readNestedNumber(usage.output_tokens_details, "cached_tokens") ??
    readNestedNumber(usage.completion_tokens_details, "cached_tokens") ??
    readNumber(usage.cached_output_tokens) ??
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
  const explicitTotal = readNumber(usage.total_tokens);
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

function usageTotalFloor(usage: Pick<
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

function sumNullableNumberList(values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) {
    return null;
  }

  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function readAnthropicCacheCreationInputTokens(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  return sumNullableNumberList([
    readNumber(value.ephemeral_5m_input_tokens),
    readNumber(value.ephemeral_1h_input_tokens)
  ]);
}

function readReasoningTokens(usage: Record<string, unknown>): number | null {
  return readNestedNumber(usage.output_tokens_details, "reasoning_tokens") ??
    readNestedNumber(usage.completion_tokens_details, "reasoning_tokens") ??
    readNestedNumber(usage.output_tokens_details, "thinking_tokens") ??
    readNestedNumber(usage.completion_tokens_details, "thinking_tokens") ??
    readNumber(usage.reasoning_output_tokens) ??
    readNumber(usage.reasoning_tokens) ??
    readNumber(usage.thinking_tokens);
}

function findUsageRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!isRecord(value) || depth > 4) {
    return null;
  }

  if (isRecord(value.usage)) {
    return value.usage;
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

function normalizeEndpoint(pathname: string): string {
  if (pathname === "/v1") {
    return "/";
  }

  if (pathname.startsWith("/v1/")) {
    return pathname.slice(3);
  }

  return pathname || "/";
}

function extractReasoningEffort(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) {
    return null;
  }

  if (typeof parsed.reasoning_effort === "string" && parsed.reasoning_effort.trim().length > 0) {
    return parsed.reasoning_effort;
  }

  if (
    isRecord(parsed.reasoning) &&
    typeof parsed.reasoning.effort === "string" &&
    parsed.reasoning.effort.trim().length > 0
  ) {
    return parsed.reasoning.effort;
  }

  const outputConfigEffort = readOutputConfigEffort(parsed);
  if (outputConfigEffort) {
    return outputConfigEffort;
  }

  if (isRecord(parsed.thinking)) {
    const visibleEffort = readThinkingEffort(parsed.thinking);
    if (visibleEffort) {
      return visibleEffort;
    }

    const type = readTrimmedString(parsed.thinking.type) ?? "";
    const budget = typeof parsed.thinking.budget_tokens === "number" ? parsed.thinking.budget_tokens : null;
    const display = readTrimmedString(parsed.thinking.display);
    const parts = [type ? `thinking ${type}` : "thinking yes"];

    if (budget !== null) {
      parts.push(`${budget}`);
    }

    if (display) {
      parts.push(display);
    }

    return parts.join(" ");
  }

  return null;
}

function extractRequestSummary(endpoint: string, parsed: Record<string, unknown> | null): string | null {
  if (!parsed) {
    return null;
  }

  if (endpoint === "/messages" || endpoint.endsWith("/messages")) {
    return joinSummaryParts([
      countArray("messages", parsed.messages),
      describeSystem(parsed.system),
      countArray("tools", parsed.tools),
      describeNumber("max", parsed.max_tokens),
      describeThinking(parsed.thinking, parsed)
    ]);
  }

  if (endpoint === "/responses" || endpoint === "/responses/compact") {
    return joinSummaryParts([
      describeInput(parsed.input),
      countCompactionItems(parsed.input),
      describePresence("instructions", parsed.instructions),
      countArray("tools", parsed.tools),
      describeNumber("max", parsed.max_output_tokens),
      describePresence("previous", parsed.previous_response_id)
    ]);
  }

  if (endpoint === "/chat/completions") {
    return joinSummaryParts([
      countArray("messages", parsed.messages),
      countArray("tools", parsed.tools),
      describeNumber("max", parsed.max_tokens)
    ]);
  }

  return joinSummaryParts([
    countArray("messages", parsed.messages),
    describeInput(parsed.input),
    countArray("tools", parsed.tools)
  ]);
}

function extractJsonErrorSummary(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return findErrorSummary(parsed);
  } catch {
    return null;
  }
}

function findErrorSummary(value: unknown, depth = 0): string | null {
  if (depth > 4) {
    return null;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findErrorSummary(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(value.error)) {
    const message = readTrimmedString(value.error.message) ?? readTrimmedString(value.error.type);
    const type = readTrimmedString(value.error.type);
    const code = readTrimmedString(value.error.code);
    return appendErrorQualifier(message, type ?? code);
  }

  const direct =
    readTrimmedString(value.error) ??
    readTrimmedString(value.message) ??
    readTrimmedString(value.detail);
  if (direct) {
    return direct;
  }

  for (const key of ["errors", "details", "data"]) {
    const found = findErrorSummary(value[key], depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function appendErrorQualifier(message: string | null, qualifier: string | null): string | null {
  if (!message) {
    return qualifier;
  }

  if (!qualifier || message.includes(qualifier)) {
    return message;
  }

  return `${message} (${qualifier})`;
}

function truncateSummary(summary: string): string {
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function joinSummaryParts(parts: Array<string | null>): string | null {
  const filtered = parts.filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(" · ") : null;
}

function countArray(label: string, value: unknown): string | null {
  return Array.isArray(value) ? `${label} ${value.length}` : null;
}

function describeSystem(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return "system yes";
  }

  if (Array.isArray(value)) {
    return `system ${value.length}`;
  }

  return null;
}

function describeInput(value: unknown): string | null {
  if (Array.isArray(value)) {
    return `input ${value.length}`;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return "input text";
  }

  if (isRecord(value)) {
    return "input object";
  }

  return null;
}

function countCompactionItems(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const count = value.filter((item) => isRecord(item) && item.type === "compaction").length;
  return count > 0 ? `compactions ${count}` : null;
}

function describePresence(label: string, value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim().length > 0 ? `${label} yes` : null;
  }

  return value === undefined || value === null ? null : `${label} yes`;
}

function describeNumber(label: string, value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? `${label} ${value}` : null;
}

function describeThinking(value: unknown, parsed?: Record<string, unknown>): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const effort = readThinkingEffort(value);
  const outputConfigEffort = parsed ? readOutputConfigEffort(parsed) : null;
  const type = readTrimmedString(value.type);
  const budget = readNumber(value.budget_tokens);
  const display = readTrimmedString(value.display);
  return joinSummaryParts([
    effort ? `thinking ${effort}` : type ? `thinking ${type}` : "thinking yes",
    outputConfigEffort ? `effort ${outputConfigEffort}` : null,
    budget !== null ? `budget ${budget}` : null,
    display ? `display ${display}` : null
  ]);
}

function readOutputConfigEffort(parsed: Record<string, unknown>): string | null {
  if (!isRecord(parsed.output_config)) {
    return null;
  }

  return readKnownThinkingLevel(parsed.output_config.effort);
}

function readThinkingEffort(value: Record<string, unknown>): string | null {
  return readKnownThinkingLevel(value.effort) ??
    readKnownThinkingLevel(value.level) ??
    readKnownThinkingLevel(value.mode);
}

function readKnownThinkingLevel(value: unknown): string | null {
  const text = readTrimmedString(value)?.toLowerCase();
  if (
    text === "low" ||
    text === "medium" ||
    text === "high" ||
    text === "xhigh" ||
    text === "max" ||
    text === "minimal"
  ) {
    return text;
  }

  return null;
}

function decodeResponseText(buffer: Buffer): string | null {
  const decoded = looksLikeGzip(buffer) ? tryGunzip(buffer) : buffer;
  if (!decoded) {
    return null;
  }

  return decoded.toString("utf8");
}

function tryGunzip(buffer: Buffer): Buffer | null {
  try {
    return gunzipSync(buffer);
  } catch {
    return null;
  }
}

function parseJsonRecord(buffer: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNestedNumber(value: unknown, key: string): number | null {
  return isRecord(value) ? readNumber(value[key]) : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readHeader(value: string | string[] | number | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return typeof value === "number" ? String(value) : null;
}

function looksLikeGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
