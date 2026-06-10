import type { IncomingHttpHeaders } from "node:http";
import { decodeBodyText } from "./http-utils.js";
import type {
  PrimaryResultCategory,
  PrimaryRouteResult
} from "./primary-failover-types.js";
import { hasTokenUsage } from "./usage.js";

const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const RATE_LIMIT_MAX_MS = 10 * 60 * 1000;

export function classifyPrimaryRouteResult(result: PrimaryRouteResult): PrimaryResultCategory {
  const summary = result.errorSummary?.toLowerCase() ?? "";

  if (hasTokenUsage(result.usage)) {
    return "success";
  }

  if (isClientCancelSummary(summary)) {
    return "client_cancel";
  }

  if (result.status >= 200 && result.status < 300 && !result.errorSummary) {
    return "success";
  }

  if (isModelIncompatibleFailure(result.status, summary)) {
    return "model_incompatible";
  }

  if (result.status === 400 || result.status === 422) {
    return "request_shape";
  }

  if (result.status === 429) {
    return "rate_limit";
  }

  if (result.status === 401 || isAuthFailureSummary(summary)) {
    return "auth";
  }

  if (result.status === 402 || result.status === 403 || isQuotaFailureSummary(summary)) {
    return "quota";
  }

  if (
    result.status === 408 ||
    result.status >= 500 ||
    isReconnectLikePrimaryFailure(result.status, result.errorSummary)
  ) {
    return "transient";
  }

  return result.status >= 400 || result.errorSummary ? "transient" : "success";
}

export function isReconnectLikePrimaryFailure(status: number, errorSummary: string | null): boolean {
  if (!errorSummary) {
    return false;
  }

  const lower = errorSummary.toLowerCase();
  if (
    status >= 200 &&
    status < 300 &&
    (
      lower.includes("openai stream closed before response.completed") ||
      lower.includes("stream closed before response.completed") ||
      lower.includes("not text/event-stream") ||
      lower.includes("without response.completed") ||
      lower.includes("without a terminal event or output token")
    )
  ) {
    return true;
  }

  if (status < 500) {
    return false;
  }

  return [
    "reconnect",
    "response aborted",
    "socket hang up",
    "econnreset",
    "network socket disconnected",
    "stream disconnected before valid content",
    "stream closed before response.completed",
    "upstream_stream_error",
    "received 0 chars"
  ].some((pattern) => lower.includes(pattern));
}

export function rateLimitCooldownMs(result: PrimaryRouteResult, failureCount: number, now: number): number {
  const retryAfterMs = parseRetryAfterMs(result.responseHeaders, now);
  if (retryAfterMs !== null) {
    return Math.min(RATE_LIMIT_MAX_MS, retryAfterMs);
  }

  return Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_FALLBACK_MS * 2 ** Math.max(0, failureCount - 1));
}

export function readResponseId(result: PrimaryRouteResult): string | null {
  const explicit = readTrimmedString(result.responseId);
  if (explicit) {
    return explicit;
  }

  const body = result.responseBody;
  if (!body || body.byteLength === 0) {
    return null;
  }

  const text = decodeBodyText(body);
  const contentType = readHeader(result.responseHeaders?.["content-type"])?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return readSseResponseId(text);
  }

  return readJsonResponseId(text);
}

function parseRetryAfterMs(headers: IncomingHttpHeaders | undefined, now: number): number | null {
  const value = readHeader(headers?.["retry-after"]);
  if (!value) {
    return null;
  }

  const seconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - now);
  }

  return null;
}

function readSseResponseId(text: string): string | null {
  const frames = text.split(/\r?\n\r?\n/);
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }

    const responseId = readJsonResponseId(data);
    if (responseId) {
      return responseId;
    }
  }

  return null;
}

function readJsonResponseId(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return readTrimmedString(parsed.id) ??
      (isRecord(parsed.response) ? readTrimmedString(parsed.response.id) : null);
  } catch {
    return null;
  }
}

function isClientCancelSummary(summary: string): boolean {
  return (
    summary.includes("client disconnected before upstream response completed") ||
    summary.includes("client canceled") ||
    summary.includes("client cancelled")
  );
}

function isAuthFailureSummary(summary: string): boolean {
  return [
    "invalid api key",
    "invalid token",
    "unauthorized",
    "authentication",
    "auth token",
    "api key is invalid"
  ].some((pattern) => summary.includes(pattern));
}

function isQuotaFailureSummary(summary: string): boolean {
  return [
    "insufficient balance",
    "insufficient_quota",
    "quota exceeded",
    "credit balance",
    "billing",
    "account balance"
  ].some((pattern) => summary.includes(pattern));
}

function isModelIncompatibleFailure(status: number, summary: string): boolean {
  if (status !== 404 && status !== 400) {
    return false;
  }

  return (
    summary.includes("model") &&
    (
      summary.includes("not found") ||
      summary.includes("does not exist") ||
      summary.includes("unavailable") ||
      summary.includes("unsupported")
    )
  );
}

function readHeader(value: IncomingHttpHeaders[string]): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return readTrimmedString(raw);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
