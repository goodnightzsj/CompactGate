import { brotliCompressSync, constants, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
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
  it.each([["br", brotliCompressSync], ["gzip", gzipSync], ["deflate", deflateSync], ["zstd", zstdCompressSync]] as const)(
    "decodes a valid empty %s stream without discarding its stored bytes", (encoding, compress) => {
      const stored = serializeBody(compress(Buffer.alloc(0)));
      expect(stored.captured_byte_length).toBeGreaterThan(0);
      expect(decodeCaptureBody(stored, { "content-encoding": encoding })).toEqual({ ...stored, text: "" });
    }
  );
  it.each([
    ["br", brotliCompressSync],
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["zstd", zstdCompressSync]
  ] as const)("bounds expanded %s captures without changing the stored bytes", (encoding, compress) => {
    const compressed = compress(Buffer.alloc(8 * 1024 * 1024 + 1, "a"));
    const stored = serializeBody(compressed);
    const decoded = decodeCaptureBody(stored, { "content-encoding": encoding });
    expect(decoded.text).toMatch(/^\[compactgate\].*解压后.*上限/);
    expect(decoded.text!.length).toBeLessThan(200);
    const { text: _text, ...unchanged } = decoded;
    expect(unchanged).toEqual(stored);
    expect(stored.truncated).toBe(false);
  });

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

  it.each([["gzip", gzipSync], ["zstd", zstdCompressSync]] as const)(
    "decodes %s and is case insensitive about the header name", (encoding, compress) => {
      const original = '{"ok":true}';
      const stored = serializeBody(compress(Buffer.from(original)));

      expect(decodeCaptureBody(stored, { "Content-Encoding": encoding }).text).toBe(original);
    }
  );

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

describe("undecodable compressed capture bodies", () => {
  it.each([
    zstdCompressSync(Buffer.alloc(0)),
    zstdCompressSync(Buffer.alloc(0), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
    zstdCompressSync(Buffer.alloc(0), { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } }),
    Buffer.from("28b52ffd2000000000010000", "hex"),
    Buffer.from("502a4d1802000000abcd", "hex")
  ])("accepts complete empty zstd frames but rejects each truncated prefix: %j", frame => {
    expect(decodeCaptureBody(serializeBody(frame), { "content-encoding": "zstd" }).text).toBe("");
    for (let length = 1; length < frame.length; length++) {
      expect(decodeCaptureBody(serializeBody(frame.subarray(0, length)), { "content-encoding": "zstd" }).text).toContain("正文无法解压");
    }
    const combined = Buffer.concat([frame, zstdCompressSync(Buffer.alloc(0))]);
    expect(decodeCaptureBody(serializeBody(combined), { "content-encoding": "zstd" }).text).toBe("");
    expect(decodeCaptureBody(serializeBody(combined.subarray(0, -1)), { "content-encoding": "zstd" }).text).toContain("正文无法解压");
  });

  it.each([["br", brotliCompressSync], ["gzip", gzipSync], ["deflate", deflateSync], ["zstd", zstdCompressSync]] as const)(
    "does not confuse an incomplete %s header with a valid empty stream", (encoding, compress) => {
      const compressed = compress(Buffer.from("synthetic nonempty body"));
      const stored = { ...serializeBody(compressed.subarray(0, 1)), byte_length: compressed.length, truncated: true };
      expect(decodeCaptureBody(stored, { "content-encoding": encoding })).toEqual({ ...stored,
        text: expect.stringContaining("正文无法解压") });
    }
  );
  it("says so instead of rendering the compressed bytes as text", () => {
    // Brotli cut off before its first flush point: nothing decodes at all. UTF-8
    // decoding the compressed bytes is what made the viewer show mojibake and
    // read as if that were the upstream's answer. (Four bytes of this fixture do
    // still salvage a prefix, which the truncated-stream test above covers.)
    const compressed = brotliCompressSync(Buffer.from(JSON.stringify({ hello: "world" })));
    const decoded = decodeCaptureBody(
      {
        byte_length: compressed.byteLength,
        captured_byte_length: 3,
        truncated: true,
        base64: compressed.subarray(0, 3).toString("base64")
      },
      { "content-encoding": "br" }
    );

    expect(decoded.text?.startsWith("[compactgate]")).toBe(true);
    expect(decoded.text).toContain("br");
    expect(decoded.byte_length).toBe(compressed.byteLength);
    expect(decoded.truncated).toBe(true);
  });

  it("leaves an unencoded body alone even when it is not valid UTF-8", () => {
    const raw = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    const decoded = decodeCaptureBody(
      {
        byte_length: raw.byteLength,
        captured_byte_length: raw.byteLength,
        truncated: false,
        base64: raw.toString("base64")
      },
      { "content-type": "application/json" }
    );

    expect(decoded.text?.startsWith("[compactgate]")).toBe(false);
    expect(decoded.text).toContain('{"');
  });

  it.each(["br", "zstd"])("reports a body whose declared %s encoding does not match its bytes", (encoding) => {
    const junk = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    const decoded = decodeCaptureBody(
      {
        byte_length: junk.byteLength,
        captured_byte_length: junk.byteLength,
        truncated: false,
        base64: junk.toString("base64")
      },
      { "content-encoding": encoding }
    );

    expect(decoded.text?.startsWith("[compactgate]")).toBe(true);
  });
});
