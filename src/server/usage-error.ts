import type { IncomingHttpHeaders } from "node:http";
import {
  decodeResponseText,
  isRecord,
  readHeader,
  readTrimmedString
} from "./usage-utils.js";

export function extractResponseErrorSummary(
  status: number,
  responseBody: Buffer,
  headers: IncomingHttpHeaders = {}
): string | null {
  if (status < 400 && readHeader(headers["content-type"])?.toLowerCase().includes("text/event-stream")) return null;
  const text = decodeResponseText(responseBody, headers);
  if (status < 400) {
    try { return responseFailureSummary(JSON.parse(text ?? "")); }
    catch { return null; }
  }
  if (!text) {
    return `Upstream returned HTTP ${status}.`;
  }

  // Try the structured read whatever the content-type claims: gateways commonly
  // return a JSON error body under `text/plain` or with no type at all, and
  // trusting the header there showed the operator the raw JSON instead of the
  // message inside it. Falling back to the trimmed body keeps plain-text and
  // HTML errors intact.
  const summary = extractJsonErrorSummary(text) ?? text.trim().replace(/\s+/g, " ");

  return summary.length > 0
    ? `Upstream returned HTTP ${status}: ${truncateSummary(summary)}`
    : `Upstream returned HTTP ${status}.`;
}

/** Only protocol envelopes declare failure; output and metadata are user content. */
export function responseFailureSummary(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const response = (value.type === "response.completed" || value.type === "response.failed" || value.type === "response.incomplete") && isRecord(value.response)
    ? value.response : value;
  const status = response.status ?? value.type;
  if (response.error == null && status !== "failed" && status !== "incomplete" &&
    status !== "response.failed" && status !== "response.incomplete" && value.type !== "error") return null;
  const reason = isRecord(response.incomplete_details) ? readTrimmedString(response.incomplete_details.reason) : null;
  const fallback = value.type === "response.failed" || value.type === "response.incomplete"
    ? `OpenAI stream ended with ${value.type}.` : `Upstream response ended with ${status ?? "error"}.`;
  const summary = findErrorSummary(response) ?? reason ?? fallback;
  return truncateSummary(appendErrorQualifier(summary, readTrimmedString(response.code)) ?? summary);
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
