import type { IncomingHttpHeaders } from "node:http";
import { constants } from "node:fs";
import { mkdir, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CaptureRecord,
  CaptureSerializedBody
} from "../shared/types.js";
import { isRecord } from "../shared/records.js";
import { captureRecordWithDecodedBodies } from "./capture-body-decode.js";

export type { CaptureRecord } from "../shared/types.js";

export type CaptureReadResult =
  | { status: "found"; record: CaptureRecord; content: Buffer }
  | { status: "unavailable" };

const DEFAULT_MAX_CAPTURE_BODY_BYTES = 8 * 1024 * 1024;
/** How far below the cap the in-memory estimate must sit to skip a full scan. */
const PRUNE_SCAN_SKIP_MARGIN = 0.9;
/** Longest a write-triggered prune may trust the in-memory estimate. */
const PRUNE_SCAN_MAX_SKIP_MS = 60_000;
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

  private readonly directoryByteEstimates = new Map<string, number>();

  private readonly lastPruneScanAt = new Map<string, number>();

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
    /**
     * Called once per prune pass with every capture it deleted, not once per
     * file: lowering the directory cap can purge the whole directory, and a
     * per-file callback turned that into thousands of individual SQLite updates
     * and SSE frames written synchronously to every open Studio.
     */
    private readonly onCapturesPurged: (capturePaths: string[]) => void = () => {}
  ) {}

  static fromEnv(onCapturesPurged?: (capturePaths: string[]) => void): DebugCaptureWriter {
    return DebugCaptureWriter.fromConfig(
      null,
      DEFAULT_MAX_CAPTURE_BODY_BYTES,
      DEFAULT_MAX_CAPTURE_DIR_BYTES,
      onCapturesPurged
    );
  }

  static fromConfig(
    captureDir: string | null,
    maxBodyBytes = DEFAULT_MAX_CAPTURE_BODY_BYTES,
    maxDirBytes = DEFAULT_MAX_CAPTURE_DIR_BYTES,
    onCapturesPurged?: (capturePaths: string[]) => void
  ): DebugCaptureWriter {
    const writer = new DebugCaptureWriter(
      null,
      DEFAULT_MAX_CAPTURE_BODY_BYTES,
      DEFAULT_MAX_CAPTURE_DIR_BYTES,
      onCapturesPurged ?? (() => {})
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
          record: captureRecordWithDecodedBodies(parsed as unknown as CaptureRecord),
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
      this.addToDirectoryByteEstimate(captureDir, Buffer.byteLength(JSON.stringify(record, null, 2)) + 1);
      void this.requestPrune(captureDir, effectiveMaxDirBytes);
    }
  }

  pruneOldCaptures(): Promise<void> {
    const captureDir = this.captureDir;
    if (!captureDir) {
      return Promise.resolve();
    }

    // An explicit prune never trusts the estimate. It is the "actually check now"
    // entry point — `configure` calls it before any capture exists, and a config
    // change calls it after the cap moves — so skipping here let a directory that
    // this process did not fill (captures left by an earlier run, a second
    // instance, files dropped in by hand) stay unbounded forever.
    return this.requestPrune(captureDir, this.maxDirBytes, { trustEstimate: false });
  }

  /**
   * Tracks the directory's size in memory so the common case can skip the scan.
   * Every capture write used to trigger a full `readdir` plus a `stat` per file —
   * measured 300 ms for a 10,000-file directory — even when the total was nowhere
   * near the cap, and the default 20 GiB cap makes tens of thousands of files a
   * normal steady state. The estimate is only ever used to decide whether a scan
   * is needed; a scan always recomputes the true total, so drift self-corrects.
   */
  private addToDirectoryByteEstimate(captureDir: string, bytes: number): void {
    const known = this.directoryByteEstimates.get(captureDir);
    if (known !== undefined) {
      this.directoryByteEstimates.set(captureDir, known + bytes);
    }
  }

  private canSkipPruneScan(captureDir: string, maxDirBytes: number): boolean {
    const known = this.directoryByteEstimates.get(captureDir);
    if (known === undefined || known > maxDirBytes * PRUNE_SCAN_SKIP_MARGIN) {
      return false;
    }

    // Bounded staleness as well as a margin. The estimate only counts what this
    // writer wrote, so anything else adding files would otherwise go unseen for as
    // long as our own total stayed under the cap; a forced rescan every interval
    // caps how far the directory can drift past it.
    const lastScanAt = this.lastPruneScanAt.get(captureDir) ?? 0;
    return Date.now() - lastScanAt < PRUNE_SCAN_MAX_SKIP_MS;
  }

  private requestPrune(
    captureDir: string,
    maxDirBytes: number,
    options: { trustEstimate?: boolean } = {}
  ): Promise<void> {
    if (options.trustEstimate !== false && this.canSkipPruneScan(captureDir, maxDirBytes)) {
      return Promise.resolve();
    }

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
      const purgedPaths: string[] = [];
      this.directoryByteEstimates.set(captureDir, totalBytes);
      this.lastPruneScanAt.set(captureDir, Date.now());

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
          this.directoryByteEstimates.set(captureDir, totalBytes);
          purgedPaths.push(file.path);
        } catch {
          // Ignore unlink errors
        }
      }

      if (purgedPaths.length > 0) {
        try {
          this.onCapturesPurged(purgedPaths);
        } catch {
          // The files are already gone; a notification failure must not make the
          // next pass delete more to compensate.
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
  // base64 only. Storing the UTF-8 decode alongside it cost 1.0x the bytes for
  // a plain body and 1.7x for a brotli one — where every invalid byte becomes a
  // 3-byte replacement char, so the copy is bigger than the original and cannot
  // be turned back into it. The API rehydrates readable text on the way out.
  return {
    byte_length: buffer.byteLength,
    captured_byte_length: capturedBody.byteLength,
    truncated: capturedBody.byteLength < buffer.byteLength,
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
