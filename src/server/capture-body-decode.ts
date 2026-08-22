import zlib from "node:zlib";
import type {
  CapturePayload,
  CaptureRecord,
  CaptureResponsePayload,
  CaptureSerializedBody
} from "../shared/types.js";

/**
 * Captures store bodies as base64 only. Readable text is derived here rather
 * than on disk, because a compressed body's UTF-8 decode is lossy — and the
 * browser cannot help: `DecompressionStream` covers gzip and deflate but not
 * brotli, which is what the relays actually send.
 */
export function captureRecordWithDecodedBodies(record: CaptureRecord): CaptureRecord {
  return {
    ...record,
    incoming_request: withDecodedBody(record.incoming_request),
    upstream_request: withDecodedBody(record.upstream_request),
    upstream_response: withDecodedBody(record.upstream_response),
    client_response: record.client_response ? withDecodedBody(record.client_response) : null
  };
}

function withDecodedBody<T extends CapturePayload | CaptureResponsePayload>(payload: T): T {
  return { ...payload, body: decodeCaptureBody(payload.body, payload.headers) };
}

export function decodeCaptureBody(
  body: CaptureSerializedBody,
  headers: Record<string, string | string[] | undefined> = {}
): CaptureSerializedBody {
  if (typeof body.text === "string") {
    // Written before base64 became the only stored copy.
    return body;
  }

  const bytes = Buffer.from(body.base64 ?? "", "base64");
  return { ...body, text: decodeBodyBytes(bytes, readContentEncoding(headers)) };
}

function decodeBodyBytes(bytes: Buffer, encoding: string): string {
  if (bytes.byteLength === 0) {
    return "";
  }

  const strategies = decompressors(encoding);
  for (const decompress of strategies) {
    try {
      const out = decompress(bytes);
      if (out.byteLength > 0) {
        return out.toString("utf8");
      }
    } catch {
      // Fall through to the next strategy.
    }
  }

  if (strategies.length > 0) {
    // The body declares an encoding and nothing could decompress it — normally a
    // capture cut off before the first flush point. UTF-8 decoding compressed
    // bytes is exactly what produced the mojibake the viewer used to show, and it
    // reads as if it were the response.
    return `[compactgate] ${encoding} 正文无法解压，可能在首个刷新点之前就被截断（已抓取 ${bytes.byteLength} 字节）。`;
  }

  return bytes.toString("utf8");
}

/**
 * The strict pass first, then a flushing pass: a capture of an aborted stream
 * holds a truncated compressed body, which only decodes partially.
 */
function decompressors(encoding: string): Array<(input: Buffer) => Buffer> {
  if (encoding.includes("br")) {
    return [
      (input) => zlib.brotliDecompressSync(input),
      (input) => zlib.brotliDecompressSync(input, {
        finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
      })
    ];
  }
  if (encoding.includes("gzip")) {
    return [
      (input) => zlib.gunzipSync(input),
      (input) => zlib.gunzipSync(input, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    ];
  }
  if (encoding.includes("deflate")) {
    return [
      (input) => zlib.inflateSync(input),
      (input) => zlib.inflateSync(input, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    ];
  }
  return [];
}

function readContentEncoding(
  headers: Record<string, string | string[] | undefined>
): string {
  const value = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "content-encoding")?.[1];
  const text = Array.isArray(value) ? value.join(",") : value ?? "";
  return text.toLowerCase();
}
