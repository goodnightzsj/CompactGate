import { execFile } from "node:child_process";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { promisify } from "node:util";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeBodyText, parseJsonRecord, readRawBody, RequestBodyTooLargeError } from "../src/server/http-utils.js";

describe("request body lifetime", () => {
  it.each(["end", "error", "aborted", "close", "limit"])("releases fragments after %s and ignores late data", async event => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--expose-gc", "--import", "tsx", "--input-type=module", "-e", String.raw`
        import assert from "node:assert/strict";
        import { IncomingMessage } from "node:http";
        import { Socket } from "node:net";
        import { setImmediate } from "node:timers/promises";
        const { readRawBody, RequestBodyTooLargeError } = await import(process.argv[1]);
        const event = process.argv[2];
        const inputBytes = 8 * 1024 * 1024;
        async function retainedBytes() {
          await setImmediate();
          for (let index = 0; index < 4; index++) global.gc();
          return process.memoryUsage().arrayBuffers;
        }
        const baseline = await retainedBytes();
        const req = new IncomingMessage(new Socket());
        const failure = new Error("synthetic read failure");
        const pending = readRawBody(req, event === "limit" ? inputBytes / 2 : undefined)
          .catch(error => error);
        for (let index = 0; index < 4; index++) req.emit("data", Buffer.alloc(inputBytes / 4, 7));
        if (event !== "limit") req.emit(event, failure);
        const result = await pending;
        if (event === "end") {
          assert.equal(result.length, inputBytes);
          assert.ok(result.every(byte => byte === 7));
        } else if (event === "limit") assert.ok(result instanceof RequestBodyTooLargeError);
        else if (event === "error") assert.equal(result, failure);
        else assert.equal(result.message, "Client disconnected before request body completed.");
        req.emit("data", Buffer.alloc(inputBytes, 9));
        req.emit("error", new Error("late read error"));
        req.emit("end");
        const retained = await retainedBytes() - baseline;
        assert.ok(req.listenerCount("error") > 0);
        if (event === "end") assert.equal(result.length, inputBytes);
        console.log(JSON.stringify({ retained, expected: event === "end" ? inputBytes : 0 }));
        req.destroy();
      `, new URL("../src/server/http-utils.ts", import.meta.url).href, event
    ]);
    const memory = JSON.parse(stdout) as { retained: number; expected: number };
    expect(memory.retained).toBeGreaterThanOrEqual(memory.expected);
    expect(memory.retained).toBeLessThan(memory.expected + 1024 * 1024);
  });
});

describe("explicit request body limits", () => {
  it("accepts exactly the explicit byte limit", async () => {
    const req = new IncomingMessage(new Socket());
    const body = Buffer.from("test");
    const result = readRawBody(req, body.byteLength);
    req.push(body);
    req.push(null);
    expect(await result).toEqual(body);
  });

  it("rejects cumulative chunks above the explicit byte limit", async () => {
    const req = new IncomingMessage(new Socket());
    const result = readRawBody(req, 4);
    const rejected = expect(result).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    req.push(Buffer.from("test"));
    req.push(Buffer.from("!"));
    req.push(null);
    await rejected;
  });

  it("keeps an explicit zero limit distinct from no limit", async () => {
    const req = new IncomingMessage(new Socket());
    const result = readRawBody(req, 0);
    const rejected = expect(result).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    req.push(Buffer.from("!"));
    req.push(null);
    await rejected;
  });
});

describe("compressed request body budgets", () => {
  const limit = 32 * 1024 * 1024;

  it.each([["gzip", gzipSync], ["zstd", zstdCompressSync]] as const)("decodes exactly 32 MiB with %s without losing the Unicode tail", (_name, compress) => {
    const tail = "\u4e2d\u6587\ud83d\ude42";
    const empty = JSON.stringify({ model: "synthetic", input: tail });
    const input = "x".repeat(limit - Buffer.byteLength(empty)) + tail;
    const text = JSON.stringify({ model: "synthetic", input });
    const body = compress(Buffer.from(text));

    expect(Buffer.byteLength(text)).toBe(limit);
    expect(decodeBodyText(body) === text).toBe(true);
    const parsed = parseJsonRecord(body);
    expect(parsed?.model).toBe("synthetic");
    expect(parsed?.input === input).toBe(true);
  });

  it.each([["gzip", gzipSync], ["zstd", zstdCompressSync]] as const)("keeps the existing decode failure above 32 MiB with %s", (_name, compress) => {
    const body = compress(Buffer.alloc(limit + 1, "x"));
    expect(decodeBodyText(body)).toBe("");
    expect(parseJsonRecord(body)).toBeNull();
  });

  it("does not apply the compressed budget to plain bodies or accept malformed compression", () => {
    const plain = Buffer.alloc(limit + 1, "x");
    expect(decodeBodyText(plain).length).toBe(plain.byteLength);
    expect(decodeBodyText(Buffer.from([0x1f, 0x8b]))).toBe("");
    expect(decodeBodyText(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toBe("");
  });
});
