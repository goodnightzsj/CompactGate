import { finished } from "node:stream/promises";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderStateStreamGate } from "../src/server/provider-state-stream.js";

const headers = { "content-type": "text/event-stream" };
const failed = 'event: response.failed\ndata: {"type":"response.failed","response":{"output":[],"error":{"code":"invalid_encrypted_content","message":"密文失效"}}}\n\n';
const started = 'event: response.created\ndata: {"type":"response.created","response":{"output":[]}}\n\n';
afterEach(() => vi.useRealTimers());

function observe(encoding?: string, codex = false) {
  const gate = new ProviderStateStreamGate({ ...headers, ...(encoding ? { "content-encoding": encoding } : {}) }, codex);
  const output: Buffer[] = [];
  gate.on("data", chunk => output.push(Buffer.from(chunk)));
  const done = finished(gate);
  return { gate, done, text: () => Buffer.concat(output).toString() };
}

describe("bounded provider-state SSE prefix", () => {
  it.each([false, true])("scopes response.done failure recovery to Codex (%s)", async codex => {
    const body = failed.replaceAll("response.failed", "response.done").replace('"output":[]', '"status":"failed","output":[]');
    const { gate, done, text } = observe(undefined, codex);
    gate.end(Buffer.from(body)); await done;
    expect(Boolean(gate.failure)).toBe(codex);
    expect(text()).toBe(codex ? "" : body);
  });

  it.each([
    '"status":"completed","output":[]',
    '"status":"incomplete","output":[]',
    '"status":"failed","output":[{"type":"function_call","name":"write"}]'
  ])("does not recover a Codex terminal with output or a non-failed status (%s)", async output => {
    const body = failed.replaceAll("response.failed", "response.done").replace('"output":[]', output);
    const { gate, done, text } = observe(undefined, true);
    gate.end(Buffer.from(body)); await done;
    expect(gate.failure).toBeNull();
    expect(text()).toBe(body);
  });

  it.each(["response.failed", "error"])("recognizes request-ID diagnostics in an early %s envelope", async type => {
    const error = { type: "invalid_request_error", code: null,
      message: "[edge-v2] Gateway error: The encrypted content for item cmp_a could not be verified. Reason: Encrypted content could not be decrypted or parsed. [hub-] [trace_id=synthetic] (request id: request_123-X)" };
    const record = type === "response.failed" ? { type, response: { output: [], error } } : { type, error };
    const { gate, done, text } = observe();
    gate.end(Buffer.from(started + `event: ${type}\ndata: ${JSON.stringify(record)}\n\n`)); await done;
    expect(gate.failure).toMatchObject({ code: "invalid_encrypted_content", evidence: "message", itemId: "cmp_a" });
    expect(text()).toBe("");
  });

  it.each([["gzip", gzipSync], ["br", brotliCompressSync], ["deflate", deflateSync], ["zstd", zstdCompressSync]] as const)(
    "decodes chunked %s failures without exposing bytes", async (encoding, compress) => {
      const { gate, done, text } = observe(encoding);
      const bytes = compress(Buffer.from(started + failed));
      for (let index = 0; index < bytes.length; index += 3) gate.write(bytes.subarray(index, index + 3));
      gate.end(); await done;
      expect(text()).toBe("");
      expect(gate.failure?.code).toBe("invalid_encrypted_content");
    });

  it.each(["\n", "\r\n", "\r"])("accepts multiline data and byte-split UTF-8 plus a trailing DONE (%j)", async newline => {
    const { gate, done, text } = observe();
    const bytes = Buffer.from((failed.replace(',"response":', ',\ndata: "response":') + 'data: [DONE]\n\n').replaceAll("\n", newline));
    for (const byte of bytes) gate.write(Buffer.from([byte]));
    gate.end(); await done;
    expect(gate.failure?.code).toBe("invalid_encrypted_content");
    expect(text()).toBe("");
  });

  it.each([
    'event: error\ndata: {"type":"error","code":"rate_limit_exceeded"}\n\n',
    'data: {malformed}\n\n' + failed,
    failed + 'data: {"type":"response.output_text.delta","delta":"visible"}\n\n',
    failed.replace('"output":[]', '"output":[{"type":"function_call","name":"write"}]'),
    failed.replace('event: response.failed', 'event: response.completed')
  ])("passes through ambiguous, non-state or output-bearing streams", async stream => {
    const { gate, done, text } = observe();
    gate.end(Buffer.from(stream)); await done;
    expect(text()).toBe(stream);
    expect(gate.failure).toBeNull();
  });

  it("releases the prefix at its byte cap and never recovers a later failure", async () => {
    const { gate, done, text } = observe();
    const prefix = ":" + "x".repeat(65536) + "\n\n";
    gate.write(Buffer.from(prefix));
    expect(text()).toBe(prefix);
    gate.end(Buffer.from(failed)); await done;
    expect(text()).toBe(prefix + failed);
    expect(gate.failure).toBeNull();
  });

  it("releases a waiting prefix after one second and cannot replay it", async () => {
    vi.useFakeTimers();
    const { gate, done, text } = observe();
    gate.write(Buffer.from(started));
    expect(text()).toBe("");
    await vi.advanceTimersByTimeAsync(1000);
    expect(text()).toBe(started);
    gate.end(Buffer.from(failed)); await done;
    expect(text()).toBe(started + failed);
    expect(gate.failure).toBeNull();
  });

  it("does not recover a truncated compressed failure", async () => {
    const { gate, done } = observe("gzip");
    gate.end(gzipSync(failed).subarray(0, -8)); await done;
    expect(gate.failure).toBeNull();
  });

  it("discards buffered bytes on cancellation and closes its timer", async () => {
    vi.useFakeTimers();
    const { gate, done, text } = observe();
    gate.write(Buffer.from(started + failed));
    const rejected = expect(done).rejects.toThrow("cancelled");
    gate.destroy(new Error("cancelled")); await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(text()).toBe("");
    expect(gate.failure).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
