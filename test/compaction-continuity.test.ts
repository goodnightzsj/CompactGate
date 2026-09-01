import { describe, expect, it } from "vitest";
import {
  decodeCompactGateCompactionSummary,
  encodeCompactGateCompactionSummary
} from "../src/server/protocol-conversion.js";
import {
  CompactionBridgeStore,
  synthesizeAssistantMessage
} from "../src/server/compaction-bridge.js";

describe("compaction continuity matrix", () => {
  it.each([
    ["same session", "session-a", "gpt-5.5"],
    ["model switch", "session-a", "gpt-5.6"],
    ["fork", "session-a-fork", "gpt-5.5"],
    ["resume", "session-resume", "gpt-5.5"],
    ["restart", "session-restart", "gpt-5.5"]
  ])("preserves signed state for %s", (_scenario, session, model) => {
    const summary = `summary for ${session}`;
    const state = encodeCompactGateCompactionSummary(summary);
    const rewritten = new CompactionBridgeStore().rewritePrimaryBody(
      Buffer.from(JSON.stringify({
        model,
        metadata: { session_id: session },
        input: [{ type: "compaction", encrypted_content: state }]
      })),
      {
        compactUpstream: "http://compact.example",
        sourceModel: model,
        targetModel: model
      },
      {
        includeStandardFallbacks: false,
        includeSyntheticFallbacks: false,
        allowReadableFallback: false
      }
    );

    expect(rewritten.remainingCompactionCount).toBe(0);
    expect(JSON.parse(rewritten.body.toString("utf8")).input).toEqual([{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: summary }]
    }]);
    expect(decodeCompactGateCompactionSummary(state)).toBe(summary);
  });

  // The readable fallback replays its text to the model as the conversation's
  // recovered memory, so an opaque provider state reaching it is silent
  // corruption rather than an error. `looksLikeEncodedBlob` only rejects blobs of
  // 80 characters or more, so anything shorter has to be turned away by the
  // structure test — which means `-` and `_`, the base64url alphabet's two
  // non-alphanumeric members, must not count as prose punctuation.
  it.each([
    ["base64url with a dash", "eyJhIjoxfQ-abcdefghijklmnop_qrst"],
    ["base64url with underscores", "AAAA-BBBB_CCCC-DDDD_EEEE-FFFF"],
    ["hyphens only", "aGVsbG8-d29ybGQ-dGhpcy1pcw"]
  ])("refuses to replay an opaque state as a summary: %s", (_case, encrypted) => {
    expect(synthesizeAssistantMessage(encrypted)).toBeNull();
  });

  it.each([
    ["english prose", "Refactored the parser: split tokenizer from the AST walker."],
    ["chinese prose", "用户要求把密钥池的轮换修好，并补了一个回归测试。"],
    ["hyphenated prose", "Fixed the retry loop - the deadline is now shared."]
  ])("still replays a real summary: %s", (_case, summary) => {
    expect(synthesizeAssistantMessage(summary)).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: summary }]
    });
  });
});
