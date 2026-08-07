import type { IncomingHttpHeaders } from "node:http";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync
} from "node:zlib";

const DEFAULT_MAX_DECODED_RESPONSE_BYTES = 8 * 1024 * 1024;

export function decodeResponseText(
  buffer: Buffer,
  headers: IncomingHttpHeaders = {}
): string | null {
  const decoded = tryDecodeResponse(buffer, headers);
  if (!decoded) {
    return null;
  }

  return decoded.toString("utf8");
}

export function parseJsonRecord(buffer: Buffer): Record<string, unknown> | null {
  const text = decodeResponseText(buffer);
  if (text === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readNestedNumber(value: unknown, key: string): number | null {
  return isRecord(value) ? readNumber(value[key]) : null;
}

export function readFirstNumber(value: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const number = readNumber(value[key]);
    if (number !== null) {
      return number;
    }
  }

  return null;
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value === "string") {
    const text = value.trim();
    const number = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    return Number.isSafeInteger(number) ? number : null;
  }

  return null;
}

export function readHeader(value: string | string[] | number | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return typeof value === "number" ? String(value) : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryDecodeResponse(buffer: Buffer, headers: IncomingHttpHeaders): Buffer | null {
  const contentEncoding = readHeader(headers["content-encoding"])?.toLowerCase() ?? "";
  if (!contentEncoding && !looksLikeGzip(buffer)) {
    return buffer;
  }

  try {
    if (contentEncoding.includes("br")) {
      return brotliDecompressSync(buffer, { maxOutputLength: DEFAULT_MAX_DECODED_RESPONSE_BYTES });
    }
    if (contentEncoding.includes("gzip") || looksLikeGzip(buffer)) {
      return gunzipSync(buffer, { maxOutputLength: DEFAULT_MAX_DECODED_RESPONSE_BYTES });
    }
    if (contentEncoding.includes("deflate")) {
      return inflateSync(buffer, { maxOutputLength: DEFAULT_MAX_DECODED_RESPONSE_BYTES });
    }
    if (contentEncoding.includes("zstd")) {
      return zstdDecompressSync(buffer, { maxOutputLength: DEFAULT_MAX_DECODED_RESPONSE_BYTES });
    }
    return buffer;
  } catch {
    return null;
  }
}

function looksLikeGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}
