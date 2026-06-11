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

export function normalizeMaxBufferedResponseBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES;
  }

  if (value === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES;
  }

  return Math.max(0, Math.floor(value));
}

export function normalizeMaxJsonResponseBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_JSON_RESPONSE_BYTES;
  }

  return Math.max(0, Math.floor(value));
}

export function normalizeMaxObservedStreamEventBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES;
  }

  return Math.max(0, Math.floor(value));
}
