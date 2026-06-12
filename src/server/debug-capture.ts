import type { IncomingHttpHeaders } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource,
  RouteKind
} from "../shared/types.js";

export interface CaptureRecord {
  request_id: string;
  time: string;
  completed_at: string;
  route: RouteKind;
  method: string;
  path: string;
  upstream_url: string;
  upstream_host: string;
  source_model: string | null;
  target_model: string | null;
  compact_bridge_replacements: number;
  compact_response_normalized: boolean;
  compact_response_normalize_reason: CompactResponseNormalizeReason | null;
  compact_response_synthetic_source: CompactResponseSyntheticSource | null;
  incoming_request: CapturePayload;
  upstream_request: CapturePayload;
  upstream_response: CaptureResponsePayload;
  client_response: CaptureResponsePayload | null;
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
  captured_byte_length: number;
  truncated: boolean;
  text: string;
  base64: string;
}

const DEFAULT_MAX_CAPTURE_BODY_BYTES = 1 * 1024 * 1024;

export class DebugCaptureWriter {
  private sequence = 0;

  private constructor(
    private readonly captureDir: string | null,
    private readonly maxBodyBytes: number
  ) {}

  static fromEnv(): DebugCaptureWriter {
    const configured = process.env.COMPACTGATE_CAPTURE_DIR?.trim();
    return new DebugCaptureWriter(
      configured ? path.resolve(configured) : null,
      normalizeMaxCaptureBodyBytes(process.env.COMPACTGATE_CAPTURE_BODY_MAX_BYTES)
    );
  }

  isEnabled(): boolean {
    return this.captureDir !== null;
  }

  serializeBody(buffer: Buffer): SerializedBody {
    return serializeBody(buffer, this.maxBodyBytes);
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

export function serializeBody(
  buffer: Buffer,
  maxBodyBytes = DEFAULT_MAX_CAPTURE_BODY_BYTES
): SerializedBody {
  const capturedBody = buffer.subarray(0, Math.max(0, maxBodyBytes));
  return {
    byte_length: buffer.byteLength,
    captured_byte_length: capturedBody.byteLength,
    truncated: capturedBody.byteLength < buffer.byteLength,
    text: capturedBody.toString("utf8"),
    base64: capturedBody.toString("base64")
  };
}

function sanitizePath(pathname: string): string {
  return pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "root";
}

function normalizeMaxCaptureBodyBytes(value: string | undefined): number {
  const text = value?.trim();
  const parsed = text && /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_MAX_CAPTURE_BODY_BYTES;
  }

  return parsed;
}
