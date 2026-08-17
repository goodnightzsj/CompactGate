export const DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_JSON_RESPONSE_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES = 64 * 1024;

export function appendBufferedResponseChunk(
  chunks: Buffer[],
  bufferedBytes: number,
  chunk: Buffer,
  maxBufferedBytes: number
): number {
  if (chunk.byteLength === 0 || bufferedBytes >= maxBufferedBytes) {
    return bufferedBytes;
  }

  if (!Number.isFinite(maxBufferedBytes)) {
    chunks.push(Buffer.from(chunk));
    return bufferedBytes + chunk.byteLength;
  }

  const remainingBytes = maxBufferedBytes - bufferedBytes;
  const bytesToCopy = Math.min(remainingBytes, chunk.byteLength);
  if (bytesToCopy > 0) {
    chunks.push(Buffer.from(chunk.subarray(0, bytesToCopy)));
  }

  return bufferedBytes + bytesToCopy;
}

function normalizeMaxBytes(
  value: number | undefined,
  fallback: number,
  allowInfinity = false
): number {
  if (value === undefined) {
    return fallback;
  }

  if (allowInfinity && value === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

/** Unbounded buffering is opt-in via Infinity; the other caps always clamp finite. */
export const normalizeMaxBufferedResponseBytes = (value: number | undefined): number =>
  normalizeMaxBytes(value, DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES, true);

export const normalizeMaxJsonResponseBytes = (value: number | undefined): number =>
  normalizeMaxBytes(value, DEFAULT_MAX_JSON_RESPONSE_BYTES);

export const normalizeMaxObservedStreamEventBytes = (value: number | undefined): number =>
  normalizeMaxBytes(value, DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES);
