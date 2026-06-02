import type { IncomingHttpHeaders } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RouteKind } from "../shared/types.js";

export interface CaptureRecord {
  request_id: string;
  time: string;
  route: RouteKind;
  method: string;
  path: string;
  upstream_url: string;
  upstream_host: string;
  source_model: string | null;
  target_model: string | null;
  compact_bridge_replacements: number;
  incoming_request: CapturePayload;
  upstream_request: CapturePayload;
  upstream_response: CaptureResponsePayload;
}

interface CapturePayload {
  headers: Record<string, string | string[]>;
  body: SerializedBody;
}

interface CaptureResponsePayload extends CapturePayload {
  status: number;
}

interface SerializedBody {
  byte_length: number;
  text: string;
  base64: string;
}

export class DebugCaptureWriter {
  private sequence = 0;

  private constructor(private readonly captureDir: string | null) {}

  static fromEnv(): DebugCaptureWriter {
    const configured = process.env.COMPACTGATE_CAPTURE_DIR?.trim();
    return new DebugCaptureWriter(configured ? path.resolve(configured) : null);
  }

  isEnabled(): boolean {
    return this.captureDir !== null;
  }

  async write(record: CaptureRecord): Promise<void> {
    if (!this.captureDir) {
      return;
    }

    await mkdir(this.captureDir, { recursive: true });
    this.sequence += 1;
    const filename = `${String(this.sequence).padStart(4, "0")}-${record.route}-${sanitizePath(record.path)}-${record.request_id}.json`;
    await writeFile(
      path.join(this.captureDir, filename),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );
  }
}

export function serializeHeaders(
  headers: IncomingHttpHeaders | Record<string, string | string[]>
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (isSensitiveHeader(name)) {
      next[name] = "[redacted]";
      continue;
    }

    if (Array.isArray(value)) {
      next[name] = [...value];
      continue;
    }

    next[name] = value;
  }

  return next;
}

function isSensitiveHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    lowerName === "authorization" ||
    lowerName === "proxy-authorization" ||
    lowerName === "x-api-key" ||
    lowerName === "api-key" ||
    lowerName === "anthropic-api-key"
  );
}

export function serializeBody(buffer: Buffer): SerializedBody {
  return {
    byte_length: buffer.byteLength,
    text: buffer.toString("utf8"),
    base64: buffer.toString("base64")
  };
}

function sanitizePath(pathname: string): string {
  return pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "root";
}
