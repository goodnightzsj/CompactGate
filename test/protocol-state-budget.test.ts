import { describe, expect, it } from "vitest";
import {
  anthropicMessageToResponses,
  anthropicMessageToResponsesCompaction,
  anthropicRequestToResponses,
  decodeCompactGateCompactionSummary,
  decodeCompactGateState,
  encodeCompactGateState,
  openAiReasoningToAnthropic,
  responsesRequestToAnthropic
} from "../src/server/protocol-conversion.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";

describe("portable cg1 state capacity", () => {
  const limit = 8 * 1024 * 1024;
  const tail = "\u4e2d\u6587\ud83d\ude42";

  it("encodes and decodes exactly 8 MiB of UTF-8 JSON", () => {
    const value = { kind: "compaction_summary", summary: tail };
    value.summary = "x".repeat(limit - Buffer.byteLength(JSON.stringify({ v: 1, ...value }))) + tail;
    const encoded = encodeCompactGateState(value);
    expect(encoded).toMatch(/^cg1_/);
    expect(Buffer.from(encoded.slice(4), "base64url").byteLength).toBe(limit);
    expect(decodeCompactGateCompactionSummary(encoded) === value.summary).toBe(true);
    expect(decodeCompactGateState(encoded)?.kind).toBe(value.kind);
  });

  it("rejects oversized state on both sides without truncating it", () => {
    const value = { kind: "compaction_summary", summary: tail };
    value.summary = "x".repeat(limit + 1 - Buffer.byteLength(JSON.stringify({ v: 1, ...value }))) + tail;
    expect(() => encodeCompactGateState(value)).toThrow(expect.objectContaining({ status: 502 }));
    const incoming = "cg1_" + Buffer.from(JSON.stringify({ v: 1, ...value })).toString("base64url");
    expect(decodeCompactGateState(incoming)).toBeNull();
    expect(decodeCompactGateCompactionSummary(incoming)).toBeNull();
    expect(() => responsesRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "synthetic", input: [{ type: "compaction", encrypted_content: incoming }]
    })))).toThrow(expect.objectContaining({ status: 422 }));
  });

  it("retains the old version-1 format and rejects malformed or unknown versions", () => {
    const legacy = "cg1_eyJ2IjoxLCJraW5kIjoiY29tcGFjdGlvbl9zdW1tYXJ5Iiwic3VtbWFyeSI6IkxlZ2FjeSBzdW1tYXJ5LiJ9";
    expect(decodeCompactGateCompactionSummary(legacy)).toBe("Legacy summary.");
    for (const invalid of [null, "gAAA_provider_state", "cg1_", "cg1_e30", "cg1_eyJ2IjoyfQ"]) {
      expect(decodeCompactGateState(invalid)).toBeNull();
    }
  });

  it("replays a large compaction summary with a fresh bridge and no saved history", () => {
    const summary = "x".repeat(2 * 1024 * 1024) + tail;
    const response = JSON.parse(anthropicMessageToResponsesCompaction(Buffer.from(JSON.stringify({
      type: "message", content: [{ type: "compaction", content: summary }]
    })), 200).toString());
    const state = response.output[0].encrypted_content;
    const input = Buffer.from(JSON.stringify({ model: "synthetic", input: response.output }));
    const converted = JSON.parse(responsesRequestToAnthropic(input).toString());
    expect(converted.messages[0].content[0].content === summary).toBe(true);
    const rewritten = new CompactionBridgeStore().rewritePrimaryBody(input,
      { compactUpstream: "https://synthetic.example", sourceModel: "synthetic", targetModel: "synthetic" },
      { includeStandardFallbacks: false, includeSyntheticFallbacks: false, allowReadableFallback: false });
    expect(rewritten.replacedCompactionCount).toBe(1);
    expect(JSON.parse(rewritten.body.toString()).input[0].content[0].text === summary).toBe(true);
    expect(decodeCompactGateCompactionSummary(state) === summary).toBe(true);
  });

  it.each(["thinking", "redacted_thinking"])("round-trips large Anthropic %s without losing provider state", (type) => {
    const text = "x".repeat(2 * 1024 * 1024) + tail;
    const block = type === "thinking"
      ? { type, thinking: text, signature: "synthetic-provider-signature" }
      : { type, data: text };
    const output = JSON.parse(anthropicMessageToResponses(Buffer.from(JSON.stringify({
      type: "message", content: [block]
    })), 200).toString()).output;
    const restored = JSON.parse(responsesRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "synthetic", input: output
    }))).toString()).messages[0].content[0];
    expect(JSON.stringify(restored) === JSON.stringify(block)).toBe(true);
  });

  it.each(["Readable summary.", ""])("round-trips large OpenAI reasoning with summary=%s", (summary) => {
    const encryptedContent = "gAAA" + "x".repeat(2 * 1024 * 1024);
    const block = openAiReasoningToAnthropic({
      type: "reasoning", encrypted_content: encryptedContent,
      summary: summary ? [{ type: "summary_text", text: summary }] : []
    });
    const restored = JSON.parse(anthropicRequestToResponses(Buffer.from(JSON.stringify({
      model: "synthetic", messages: [{ role: "assistant", content: [block] }]
    }))).toString()).input[0];
    expect(restored.encrypted_content === encryptedContent).toBe(true);
    expect(restored.summary).toEqual(summary ? [{ type: "summary_text", text: summary }] : []);
  });
});
