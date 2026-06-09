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
