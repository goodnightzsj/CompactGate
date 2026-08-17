import { describe, expect, it } from "vitest";
import {
  decodeCompactGateCompactionSummary,
  encodeCompactGateCompactionSummary
} from "../src/server/protocol-conversion.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";

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
});
