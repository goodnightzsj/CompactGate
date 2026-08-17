import type { IncomingHttpHeaders } from "node:http";
import { constants } from "node:fs";
import { mkdir, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CaptureRecord,
  CaptureSerializedBody
} from "../shared/types.js";
import { isRecord } from "../shared/records.js";

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

  private readonly maxDirBytesByCaptureDir = new Map<string, number>();

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
      this.maxDirBytesByCaptureDir.set(this.captureDir, maxDirBytes);
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
        if (!isRecord(parsed) || parsed.request_id !== requestId) {
          return { status: "unavailable" };
        }

        return {
          status: "found",
          // Shape is trusted: this process wrote the file. The real gates are the
          // managed-filename pattern, O_NOFOLLOW, isFile(), and the request_id match.
          record: parsed as unknown as CaptureRecord,
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
      const effectiveMaxDirBytes = this.maxDirBytesByCaptureDir.get(captureDir) ?? this.maxDirBytes;
      void this.requestPrune(captureDir, effectiveMaxDirBytes);
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
  headers: IncomingHttpHeaders | Record<string, string | string[]>,
  additionalSensitiveNames: readonly string[] = []
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};
  const additionalSensitive = new Set(additionalSensitiveNames.map((name) => name.toLowerCase()));

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (isSensitiveHeader(name) || additionalSensitive.has(name.toLowerCase())) {
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
    lowerName === "anthropic-api-key" ||
    lowerName === "cookie" ||
    lowerName === "set-cookie"
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
