import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { ConfigError } from "./config.js";
import type { LogStatusKind, RouteKind } from "../shared/types.js";

const DEFAULT_MAX_DECODED_BODY_BYTES = 8 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null
): Record<string, string> {
  const next: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === "host") {
      continue;
    }

    if (typeof value === "string") {
      next[lowerName] = value;
    } else if (Array.isArray(value)) {
      next[lowerName] = value.join(", ");
    }
  }

  if (apiKey) {
    next.authorization = `Bearer ${apiKey}`;
  }

  return next;
}

export function copyResponseHeaders(headers: IncomingHttpHeaders, res: ServerResponse): void {
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) {
      continue;
    }

    res.setHeader(name, value);
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const rawBody = await readRawBody(req);
  if (rawBody.byteLength === 0) {
    return {};
  }

  return JSON.parse(decodeBodyText(rawBody)) as unknown;
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
  }
}

export function readRawBody(
  req: IncomingMessage,
  limitBytes = 10 * 1024 * 1024
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let bodyTooLarge = false;
    let settled = false;

    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      finish();
    };

    const rejectClientAbort = () => {
      if (bodyTooLarge || req.complete) {
        return;
      }

      settle(() => reject(new Error("Client disconnected before request body completed.")));
    };

    req.on("data", (chunk: Buffer) => {
      if (bodyTooLarge) {
        return;
      }

      total += chunk.byteLength;
      if (total > limitBytes) {
        bodyTooLarge = true;
        chunks.length = 0;
        settle(() => reject(new RequestBodyTooLargeError()));
        req.resume();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (bodyTooLarge) {
        return;
      }

      settle(() => resolve(Buffer.concat(chunks)));
    });

    req.on("error", (error) => {
      if (!bodyTooLarge) {
        settle(() => reject(error));
      }
    });

    req.on("aborted", rejectClientAbort);
    req.on("close", rejectClientAbort);
  });
}

export function readHeaderString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const joined = value.join(", ").trim();
    return joined.length > 0 ? joined : null;
  }

  const text = value?.trim();
  return text && text.length > 0 ? text : null;
}

export function endpointFromPath(pathname: string): string {
  if (pathname === "/v1") {
    return "/";
  }

  if (pathname.startsWith("/v1/")) {
    return pathname.slice(3);
  }

  return pathname || "/";
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.byteLength));
  res.end(body);
}

export function statusForError(error: unknown): number {
  if (error instanceof ConfigError) {
    return 400;
  }

  if (error instanceof RequestBodyTooLargeError) {
    return 413;
  }

  if (error instanceof SyntaxError) {
    return 400;
  }

  return 500;
}

export function summaryForError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

export function parseRouteFilter(value: string | null): RouteKind | undefined {
  if (value === "primary" || value === "compact" || value === "claude") {
    return value;
  }

  return undefined;
}

export function parseStatusFilter(value: string | null): LogStatusKind | undefined {
  return value === "normal" || value === "error" ? value : undefined;
}

export function parseHostFilter(value: string | null): string | undefined {
  const host = value?.trim();
  return host && host.length > 0 ? host : undefined;
}

export function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = parseDecimalInteger(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, 2_000);
}

export function parseNonNegativeInteger(value: string | null, fallback: number): number {
  const parsed = parseDecimalInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function parseDecimalInteger(value: string | null): number {
  return value && /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

export function decodeBodyText(body: Buffer): string {
  if (body.byteLength === 0) {
    return "";
  }

  if (!looksLikeGzip(body)) {
    return body.toString("utf8");
  }

  try {
    return gunzipSync(body, {
      maxOutputLength: DEFAULT_MAX_DECODED_BODY_BYTES
    }).toString("utf8");
  } catch {
    return "";
  }
}

export function parseJsonRecord(buffer: Buffer): Record<string, unknown> | null {
  const text = decodeBodyText(buffer);

  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function looksLikeGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
