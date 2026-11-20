import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { countCompactResponseItems, normalizeCompactResponse } from "../src/server/compact-response-normalizer.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";
import { MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES } from "../src/server/upstream-response-buffer.js";

const item = { type: "compaction", encrypted_content: "Verified summary returned by the synthetic upstream." };
const response = { object: "response.compaction", output: [item] };
const requestBody = Buffer.from(JSON.stringify({ input: "Different text supplied with the original request." }));
const scope = { compactUpstream: "https://compact.example/v1", sourceModel: "synthetic", targetModel: "synthetic" };

describe("encoded Remote V1 responses", () => {
  it.each([true, false])("reads request history only when the compact stream has no output (hasOutput=%s)", hasOutput => {
    const history = "Keep the independently supplied request context for the next turn.";
    const requestBody = Buffer.from(JSON.stringify({ input: history }));
    const readHistory = vi.spyOn(requestBody, "toString");
    const output = hasOutput ? [item] : [];
    const responseBody = Buffer.from("data: " + JSON.stringify({ type: "response.completed", response: { output } }) + "\n\n");
    try {
      expect(normalizeCompactResponse({ status: 200, responseBody,
        responseHeaders: { "content-type": "text/event-stream" }, requestBody })).toEqual({
        normalized: true, reason: "missing_compaction_output",
        syntheticSource: hasOutput ? "upstream_response" : "request_input",
        responseItemCount: hasOutput ? 1 : 0,
        bridgeOutput: hasOutput ? output : [{ type: "compaction", encrypted_content: history }]
      });
      if (hasOutput) expect(readHistory).not.toHaveBeenCalled();
      else expect(readHistory).toHaveBeenCalled();
    } finally { readHistory.mockRestore(); }
  });

  it("keeps the wire item count separate from a bridge-only synthetic item", () => {
    const wire = Buffer.from(JSON.stringify({ output_text: item.encrypted_content }));
    const headers = { "content-type": "application/json" };
    const result = normalizeCompactResponse({ status: 200, responseBody: wire, responseHeaders: headers, requestBody });
    expect(result).toMatchObject({ normalized: true, responseItemCount: 0, bridgeOutput: [item] });
    expect(countCompactResponseItems(wire, headers)).toBe(0);
  });

  it.each([
    ["identity", (bytes: Buffer) => bytes], ["gzip", gzipSync], ["br", brotliCompressSync],
    ["deflate", deflateSync], ["zstd", zstdCompressSync]
  ] as const)("uses the same upstream output for %s JSON and SSE", (encoding, compress) => {
    for (const eventStream of [false, true]) {
      const headers = { "content-type": eventStream ? "text/event-stream" : "application/json", "content-encoding": encoding };
      const wire = compress(Buffer.from(eventStream
        ? [ { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response } ]
          .map(event => "data: " + JSON.stringify(event) + "\n\n").join("")
        : JSON.stringify(response)));
      const result = normalizeCompactResponse({ status: 200, responseBody: wire, responseHeaders: headers, requestBody });
      expect(countCompactResponseItems(wire, headers)).toBe(1);
      expect(result).toMatchObject({ responseItemCount: 1, bridgeOutput: [item], normalized: eventStream,
        syntheticSource: eventStream ? "upstream_response" : null });
      const bridge = new CompactionBridgeStore();
      bridge.storeCompactResponse(result.bridgeOutput, { scope });
      expect(bridge.rewritePrimaryBody(Buffer.from(JSON.stringify({ input: [item] })), scope, { allowReadableFallback: false }))
        .toMatchObject({ replacedCompactionCount: 1, remainingCompactionCount: 0 });
    }
  });

  it.each(["br", "gzip", "deflate", "zstd", "unsupported", "br, gzip"])("never interprets undecodable %s bytes as a summary", encoding => {
    const body = Buffer.from("This is readable text but its declared compression is invalid.");
    const headers = { "content-type": "text/plain", "content-encoding": encoding };
    const result = normalizeCompactResponse({ status: 200, responseBody: body, responseHeaders: headers, requestBody });
    expect(result).toMatchObject({ normalized: false, responseItemCount: 0, bridgeOutput: [] });
    expect(countCompactResponseItems(body, headers)).toBe(0);
  });

  it("limits decompressed compact responses to the complete-response budget", () => {
    const wire = gzipSync(Buffer.alloc(MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES + 1, "a"));
    const headers = { "content-type": "text/plain", "content-encoding": "gzip" };
    expect(normalizeCompactResponse({ status: 200, responseBody: wire, responseHeaders: headers, requestBody }))
      .toMatchObject({ normalized: false, responseItemCount: 0, bridgeOutput: [] });
  });
});
