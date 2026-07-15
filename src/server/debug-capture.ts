import type { IncomingHttpHeaders } from "node:http";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
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
const DEFAULT_MAX_CAPTURE_DIR_BYTES = 20 * 1024 * 1024 * 1024;
const CAPTURE_FILE_PREFIX = "compactgate-capture-";
const CAPTURE_FILE_PATTERN = new RegExp(
  `^(?:${CAPTURE_FILE_PREFIX})?\\d{4,}-(?:primary|compact|claude)-[a-z0-9-]+-` +
    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$",
  "i"
);

export class DebugCaptureWriter {
  private sequence = 0;

  private readonly protectedCapturePaths = new Set<string>();

  private readonly pruneStates = new Map<
    string,
    {
      maxDirBytes: number;
      requested: boolean;
      promise: Promise<void> | null;
    }
  >();

  private constructor(
    private captureDir: string | null,
    private maxBodyBytes: number,
    private maxDirBytes: number,
    private readonly onCapturePurged: (capturePath: string) => void = () => {}
  ) {}

  static fromEnv(onCapturePurged?: (capturePath: string) => void): DebugCaptureWriter {
    return DebugCaptureWriter.fromConfig(
      null,
      DEFAULT_MAX_CAPTURE_BODY_BYTES,
      DEFAULT_MAX_CAPTURE_DIR_BYTES,
      onCapturePurged
    );
  }

  static fromConfig(
    captureDir: string | null,
    maxBodyBytes = DEFAULT_MAX_CAPTURE_BODY_BYTES,
    maxDirBytes = DEFAULT_MAX_CAPTURE_DIR_BYTES,
    onCapturePurged?: (capturePath: string) => void
  ): DebugCaptureWriter {
    const writer = new DebugCaptureWriter(
      null,
      DEFAULT_MAX_CAPTURE_BODY_BYTES,
      DEFAULT_MAX_CAPTURE_DIR_BYTES,
      onCapturePurged ?? (() => {})
    );
    writer.configure(captureDir, maxBodyBytes, maxDirBytes);
    return writer;
  }

  configure(
    captureDir: string | null,
    maxBodyBytes = DEFAULT_MAX_CAPTURE_BODY_BYTES,
    maxDirBytes = DEFAULT_MAX_CAPTURE_DIR_BYTES
  ): void {
    const envDir = process.env.COMPACTGATE_CAPTURE_DIR?.trim();
    this.captureDir = envDir
      ? path.resolve(envDir)
      : captureDir
        ? path.resolve(captureDir)
        : null;
    const envMax = process.env.COMPACTGATE_CAPTURE_BODY_MAX_BYTES;
    this.maxBodyBytes = envMax ? normalizeMaxCaptureBodyBytes(envMax) : maxBodyBytes;
    this.maxDirBytes = maxDirBytes;
    if (this.captureDir) {
      void this.pruneOldCaptures();
    }
  }

  isEnabled(): boolean {
    return this.captureDir !== null;
  }

  serializeBody(buffer: Buffer): SerializedBody {
    return serializeBody(buffer, this.maxBodyBytes);
  }

  async write(
    record: CaptureRecord,
    onWritten?: (capturePath: string) => void
  ): Promise<string | null> {
    const captureDir = this.captureDir;
    const maxDirBytes = this.maxDirBytes;
    if (!captureDir) {
      return null;
    }

    this.sequence += 1;
    const filename = `${CAPTURE_FILE_PREFIX}${String(this.sequence).padStart(4, "0")}-${record.route}-${sanitizePath(record.path)}-${record.request_id}.json`;
    const absolutePath = path.join(captureDir, filename);
    this.protectedCapturePaths.add(absolutePath);
    try {
      await mkdir(captureDir, { recursive: true });
      await writeFile(
        absolutePath,
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8"
      );
      onWritten?.(absolutePath);
      return absolutePath;
    } finally {
      this.protectedCapturePaths.delete(absolutePath);
      void this.requestPrune(captureDir, maxDirBytes);
    }
  }

  pruneOldCaptures(): Promise<void> {
    const captureDir = this.captureDir;
    if (!captureDir) {
      return Promise.resolve();
    }

    return this.requestPrune(captureDir, this.maxDirBytes);
  }

  private requestPrune(captureDir: string, maxDirBytes: number): Promise<void> {
    let state = this.pruneStates.get(captureDir);
    if (!state) {
      state = {
        maxDirBytes,
        requested: false,
        promise: null
      };
      this.pruneStates.set(captureDir, state);
    }

    state.maxDirBytes = maxDirBytes;
    state.requested = true;
    if (state.promise) {
      return state.promise;
    }

    const prunePromise = this.runPruneLoop(captureDir, state).finally(async () => {
      if (state.promise === prunePromise) {
        state.promise = null;
      }
      if (state.requested) {
        await this.requestPrune(captureDir, state.maxDirBytes);
      } else {
        this.pruneStates.delete(captureDir);
      }
    });
    state.promise = prunePromise;
    return prunePromise;
  }

  private async runPruneLoop(
    captureDir: string,
    state: { maxDirBytes: number; requested: boolean }
  ): Promise<void> {
    do {
      state.requested = false;
      await this.pruneOnce(captureDir, state.maxDirBytes);
    } while (state.requested);
  }

  private async pruneOnce(captureDir: string, maxDirBytes: number): Promise<void> {
    try {
      const files = await readdir(captureDir);
      const captureFiles = files.filter(isManagedCaptureFilename);
      const fileSizes: Array<{ path: string; size: number; mtime: Date }> = [];

      for (const file of captureFiles) {
        const fullPath = path.join(captureDir, file);
        try {
          const stats = await stat(fullPath);
          if (!stats.isFile()) {
            continue;
          }
          fileSizes.push({ path: fullPath, size: stats.size, mtime: stats.mtime });
        } catch {
          // File may have been deleted; skip
        }
      }

      fileSizes.sort((a, b) => {
        const mtimeDifference = a.mtime.getTime() - b.mtime.getTime();
        return mtimeDifference !== 0 ? mtimeDifference : a.path.localeCompare(b.path);
      });

      let totalBytes = fileSizes.reduce((sum, f) => sum + f.size, 0);

      for (const file of fileSizes) {
        if (totalBytes <= maxDirBytes) {
          break;
        }
        if (this.protectedCapturePaths.has(file.path)) {
          continue;
        }
        try {
          await unlink(file.path);
          totalBytes -= file.size;
          try {
            this.onCapturePurged(file.path);
          } catch {
            // Capture deletion succeeded; callback failures must not over-prune.
          }
        } catch {
          // Ignore unlink errors
        }
      }
    } catch {
      // Ignore readdir errors
    }
  }
}

function isManagedCaptureFilename(filename: string): boolean {
  return CAPTURE_FILE_PATTERN.test(filename);
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
