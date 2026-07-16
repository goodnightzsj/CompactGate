import type { IncomingHttpHeaders } from "node:http";
import { constants } from "node:fs";
import { mkdir, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CaptureRecord,
  CaptureSerializedBody
} from "../shared/types.js";

export type { CaptureRecord } from "../shared/types.js";

export type CaptureReadResult =
  | { status: "found"; record: CaptureRecord; content: Buffer }
  | { status: "unavailable" };

const DEFAULT_MAX_CAPTURE_BODY_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_DIR_BYTES = 20 * 1024 * 1024 * 1024;
const CAPTURE_FILE_PREFIX = "compactgate-capture-";
const MAX_CAPTURE_FILENAME_CHARS = 240;
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

  serializeBody(buffer: Buffer): CaptureSerializedBody {
    return serializeBody(buffer, this.maxBodyBytes);
  }

  async readCapture(capturePath: string, requestId: string): Promise<CaptureReadResult> {
    if (!path.isAbsolute(capturePath)) {
      return { status: "unavailable" };
    }

    const resolvedPath = path.resolve(capturePath);
    if (!isManagedCaptureFilename(path.basename(resolvedPath))) {
      return { status: "unavailable" };
    }

    try {
      const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
          return { status: "unavailable" };
        }

        const content = await handle.readFile();
        const parsed = JSON.parse(content.toString("utf8")) as unknown;
        if (!isCaptureRecord(parsed) || parsed.request_id !== requestId) {
          return { status: "unavailable" };
        }

        return {
          status: "found",
          record: parsed,
          content
        };
      } finally {
        await handle.close();
      }
    } catch {
      return { status: "unavailable" };
    }
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
    const filename = captureFilename(this.sequence, record);
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

function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.request_id === "string" &&
    typeof value.time === "string" &&
    typeof value.completed_at === "string" &&
    isRouteKind(value.route) &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    typeof value.upstream_url === "string" &&
    typeof value.upstream_host === "string" &&
    isNullableString(value.source_model) &&
    isNullableString(value.target_model) &&
    typeof value.compact_bridge_replacements === "number" &&
    typeof value.compact_response_normalized === "boolean" &&
    isNullableString(value.compact_response_normalize_reason) &&
    isNullableString(value.compact_response_synthetic_source) &&
    isCapturePayload(value.incoming_request) &&
    isCapturePayload(value.upstream_request) &&
    isCaptureResponsePayload(value.upstream_response) &&
    (value.client_response === null || isCaptureResponsePayload(value.client_response))
  );
}

function isCapturePayload(value: unknown): boolean {
  return isRecord(value) && isHeaders(value.headers) && isSerializedBody(value.body);
}

function isCaptureResponsePayload(value: unknown): boolean {
  return isCapturePayload(value) && typeof (value as Record<string, unknown>).status === "number";
}

function isSerializedBody(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.byte_length === "number" &&
    typeof value.captured_byte_length === "number" &&
    typeof value.truncated === "boolean" &&
    typeof value.text === "string" &&
    typeof value.base64 === "string"
  );
}

function isHeaders(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(
    (header) =>
      typeof header === "string" ||
      (Array.isArray(header) && header.every((item) => typeof item === "string"))
  );
}

function isRouteKind(value: unknown): boolean {
  return value === "primary" || value === "compact" || value === "claude";
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): CaptureSerializedBody {
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

function captureFilename(sequence: number, record: CaptureRecord): string {
  const prefix =
    `${CAPTURE_FILE_PREFIX}${String(sequence).padStart(4, "0")}-${record.route}-`;
  const suffix = `-${record.request_id}.json`;
  const maxPathChars = Math.max(
    1,
    MAX_CAPTURE_FILENAME_CHARS - prefix.length - suffix.length
  );
  const pathSegment =
    sanitizePath(record.path).slice(0, maxPathChars).replace(/-+$/g, "") ||
    "root".slice(0, maxPathChars) ||
    "r";
  return `${prefix}${pathSegment}${suffix}`;
}

function normalizeMaxCaptureBodyBytes(value: string | undefined): number {
  const text = value?.trim();
  const parsed = text && /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_MAX_CAPTURE_BODY_BYTES;
  }

  return parsed;
}
