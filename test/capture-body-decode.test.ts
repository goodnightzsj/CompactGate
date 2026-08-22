import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  captureRecordWithDecodedBodies,
  decodeCaptureBody
} from "../src/server/capture-body-decode.js";
import { serializeBody } from "../src/server/debug-capture.js";
import type { CaptureRecord } from "../src/shared/types.js";

/**
 * The stored copy is base64 only: for a compressed body the UTF-8 decode was
 * both larger than the bytes it came from and irreversible, so it could not be
 * the copy that survives. Readable text is derived on the way out instead.
 */
describe("capture bodies are stored as bytes and decoded on read", () => {
  it("writes no text field to disk", () => {
    const body = serializeBody(Buffer.from('{"model":"gpt-5.5"}'));

    expect(body).toEqual({
      byte_length: 19,
      captured_byte_length: 19,
      truncated: false,
      base64: Buffer.from('{"model":"gpt-5.5"}').toString("base64")
    });
    expect(Object.hasOwn(body, "text")).toBe(false);
  });

  it("recovers a plain body byte for byte", () => {
    const original = '{"input":"你好 world"}';
    const decoded = decodeCaptureBody(serializeBody(Buffer.from(original)), {});

    expect(decoded.text).toBe(original);
  });

  it("decompresses a brotli body that used to render as mojibake", () => {
    const original = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const compressed = brotliCompressSync(Buffer.from(original));
    const stored = serializeBody(compressed);

    // The old text field was the UTF-8 decode of the compressed bytes: bigger
    // than the input and unreadable.
    expect(compressed.toString("utf8")).not.toBe(original);

    expect(decodeCaptureBody(stored, { "content-encoding": "br" }).text).toBe(original);
  });

  it("decodes gzip and is case insensitive about the header name", () => {
    const original = '{"ok":true}';
    const stored = serializeBody(gzipSync(Buffer.from(original)));

    expect(decodeCaptureBody(stored, { "Content-Encoding": "gzip" }).text).toBe(original);
  });

  it("salvages the readable prefix of a truncated compressed stream", () => {
    // What a capture of an aborted stream actually holds: a brotli body cut off
    // partway through, which the strict pass refuses outright.
    const original = Array.from(
      { length: 200 },
      (_unused, index) =>
        `event: content_block_delta\ndata: {"index":${index},"delta":{"text":"frame ${index}"}}\n\n`
    ).join("");
    const compressed = brotliCompressSync(Buffer.from(original));
    const stored = serializeBody(compressed.subarray(0, Math.floor(compressed.byteLength * 0.7)));

    const text = decodeCaptureBody(stored, { "content-encoding": "br" }).text ?? "";
    expect(text.startsWith("event: content_block_delta")).toBe(true);
    expect(text.length).toBeGreaterThan(original.length / 2);
    expect(text.length).toBeLessThan(original.length);
  });

  it("leaves an empty body as an empty string rather than undefined", () => {
    expect(decodeCaptureBody(serializeBody(Buffer.alloc(0)), {}).text).toBe("");
  });

  it("keeps the text already stored in a capture written before the change", () => {
    const legacy = {
      byte_length: 4,
      captured_byte_length: 4,
      truncated: false,
      text: "legacy",
      base64: Buffer.from("beep").toString("base64")
    };

    expect(decodeCaptureBody(legacy, {}).text).toBe("legacy");
  });

  it("decodes every section of a record and tolerates a null client response", () => {
    const record = {
      client_response: null,
      incoming_request: { headers: {}, body: serializeBody(Buffer.from("in")) },
      upstream_request: { headers: {}, body: serializeBody(Buffer.from("up")) },
      upstream_response: {
        status: 200,
        headers: { "content-encoding": "gzip" },
        body: serializeBody(gzipSync(Buffer.from("down")))
      }
    } as unknown as CaptureRecord;

    const decoded = captureRecordWithDecodedBodies(record);

    expect(decoded.incoming_request.body.text).toBe("in");
    expect(decoded.upstream_request.body.text).toBe("up");
    expect(decoded.upstream_response.body.text).toBe("down");
    expect(decoded.client_response).toBeNull();
  });
});
