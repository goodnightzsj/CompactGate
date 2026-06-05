import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { ConfigError } from "./config.js";
import type { LogStatusKind, RouteKind } from "../shared/types.js";

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

  return JSON.parse(rawBody.toString("utf8")) as unknown;
}

export function readRawBody(
  req: IncomingMessage,
  limitBytes = 10 * 1024 * 1024
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limitBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
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
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, 2_000);
}

export function parseNonNegativeInteger(value: string | null, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

export function decodeBodyText(body: Buffer): string {
  if (body.byteLength === 0) {
    return "";
  }

  if (!looksLikeGzip(body)) {
    return body.toString("utf8");
  }

  try {
    return gunzipSync(body).toString("utf8");
  } catch {
    return "";
  }
}

export function parseJsonRecord(buffer: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    if (!looksLikeGzip(buffer)) {
      return null;
    }

    try {
      const parsed = JSON.parse(gunzipSync(buffer).toString("utf8")) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function looksLikeGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
