import { gunzipSync } from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";
import type { RequestTransport } from "../shared/types.js";

export interface RequestMetadata {
  endpoint: string;
  requestType: RequestTransport;
  reasoningEffort: string | null;
}

export interface TokenUsageMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
}

const EMPTY_USAGE: TokenUsageMetrics = {
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  totalTokens: null
};

export function extractRequestMetadata(pathname: string, rawBody: Buffer): RequestMetadata {
  const endpoint = normalizeEndpoint(pathname);
  const parsed = parseJsonRecord(rawBody);

  return {
    endpoint,
    requestType: parsed?.stream === true ? "stream" : "http",
    reasoningEffort: extractReasoningEffort(parsed)
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
      latestUsage = usage;
    }
  }

  return latestUsage;
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
  const cachedInputTokens =
    readNestedNumber(usage.input_tokens_details, "cached_tokens") ??
    readNestedNumber(usage.prompt_tokens_details, "cached_tokens") ??
    readNumber(usage.cached_tokens) ??
    readNumber(usage.cache_read_input_tokens);
  const totalTokens =
    readNumber(usage.total_tokens) ??
    (inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null);

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens
  };
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
