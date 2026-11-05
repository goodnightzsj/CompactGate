import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encryptedAgentMessage } from "./helpers/encrypted-agent-message.js";
import {
  analyzeProviderState,
  compileProviderStateAttempt,
  hashProviderStateBody,
  isValidGptReasoningEncryptedContent,
  providerStateErrorCode
} from "../src/server/provider-state-portability.js";

function validEncryptedContent(): string {
  const payload = Buffer.alloc(73);
  payload[0] = 0x80;
  return payload.toString("base64url");
}

function parseBody(body: Buffer): Record<string, unknown> {
  return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
}

const WELFARE_CAPTURE_PATH = path.resolve(
  "compactgate-captures/compactgate-capture-1112-primary-v1-responses-777c28a9-e422-4939-8495-16d8d3af587f.json"
);
const welfareFixtureIt = existsSync(WELFARE_CAPTURE_PATH) ? it : it.skip;

describe("provider state portability", () => {
  it("recognizes encrypted agent messages without reasoning or compaction", () => {
    const analysis = analyzeProviderState(Buffer.from(JSON.stringify({ input: [encryptedAgentMessage] })));
    expect(analysis).toMatchObject({ hasProviderOwnedState: true, encryptedAgentMessageCount: 1 });
    expect(JSON.stringify(analysis)).not.toContain("opaque-agent-state");
    expect(analyzeProviderState(Buffer.from(JSON.stringify({ input: [{
      ...encryptedAgentMessage, content: [encryptedAgentMessage.content[0]]
    }] }))).hasProviderOwnedState).toBe(false);
  });

  it.each(["original", "cpa", "error_400"] as const)(
    "preserves encrypted agent content during unrelated %s processing", (strategy) => {
      const canonical = Buffer.from(JSON.stringify({ input: [encryptedAgentMessage] }));
      const result = compileProviderStateAttempt(canonical, { strategy, errorCode: "previous_response_not_found" });
      expect(result.body).toBe(canonical);
    }
  );

  it.each(["original", "cpa"] as const)(
    "removes agent ciphertext after explicit failure from %s while retaining other context", (priorStrategy) => {
      const businessData = { type: "encrypted_content", encrypted_content: "caller-data" };
      const body = { store: false, metadata: businessData, input: [
        encryptedAgentMessage,
        { type: "compaction", id: "cmp_keep", encrypted_content: "opaque-compaction-state" },
        { type: "custom_tool_call", id: "tool_keep", call_id: "call_keep", input: JSON.stringify(businessData) },
        { type: "custom_tool_call_output", call_id: "call_keep", output: JSON.stringify(businessData) },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue", metadata: businessData }] }
      ] };
      const canonical = Buffer.from(JSON.stringify(body));
      const result = compileProviderStateAttempt(canonical, {
        strategy: "error_400", priorStrategy, errorCode: "invalid_encrypted_content"
      });
      expect(parseBody(result.body)).toEqual({ ...body, input: [
        { ...encryptedAgentMessage, content: [encryptedAgentMessage.content[0]] }, ...body.input.slice(1)
      ] });
      expect(result.metrics).toMatchObject({ encryptedAgentMessageBlocksRemoved: 1, compactionItemsRemoved: 0 });
      expect(result.fidelity).toBe("degraded");
      expect(parseBody(canonical)).toEqual(body);
    }
  );

  it.each(["cross_domain", "error_400"] as const)("keeps agent ciphertext removed through %s", (strategy) => {
    const canonical = Buffer.from(JSON.stringify({ input: [encryptedAgentMessage] }));
    const result = compileProviderStateAttempt(canonical, {
      strategy, priorStrategy: "cross_domain", errorCode: "invalid_encrypted_content"
    });
    expect(parseBody(result.body).input).toEqual([{
      type: "agent_message", author: "agent_synthetic", recipient: "all", content: [encryptedAgentMessage.content[0]]
    }]);
    expect(result.metrics).toMatchObject({ encryptedAgentMessageBlocksRemoved: 1 });
    expect(result.fidelity).toBe("degraded");
  });

  it.each([[], [{ type: "input_text", text: "  " }], [{ type: "unknown", text: "not a text fallback" }]]
    .map(content => ({ content })))(
    "retains agent ciphertext when no readable text is available: $content", ({ content }) => {
      const canonical = Buffer.from(JSON.stringify({ input: [{
        ...encryptedAgentMessage, content: [...content, encryptedAgentMessage.content[1]]
      }] }));
      const result = compileProviderStateAttempt(canonical, { strategy: "error_400", errorCode: "invalid_encrypted_content" });
      expect(result.body).toBe(canonical);
      expect(analyzeProviderState(canonical).hasProviderOwnedState).toBe(true);
    }
  );

  it("counts multiple encrypted blocks and ignores caller-owned lookalikes", () => {
    const nested = { input: [encryptedAgentMessage] };
    const canonical = Buffer.from(JSON.stringify({ metadata: nested, input: [
      { ...encryptedAgentMessage, content: [...encryptedAgentMessage.content, encryptedAgentMessage.content[1]] },
      { type: "custom_tool_call_output", call_id: "business", output: nested },
      { type: "other", content: encryptedAgentMessage.content }
    ] }));
    const result = compileProviderStateAttempt(canonical, { strategy: "error_400", errorCode: "invalid_encrypted_content" });
    const expected = parseBody(canonical);
    (expected.input as Array<Record<string, unknown>>)[0].content = [encryptedAgentMessage.content[0]];
    expect(parseBody(result.body)).toEqual(expected);
    expect(result.metrics.encryptedAgentMessageBlocksRemoved).toBe(2);
    expect(analyzeProviderState(canonical).encryptedAgentMessageCount).toBe(1);
    expect(analyzeProviderState(Buffer.from(JSON.stringify({ input: [
      { type: "custom_tool_call_output", call_id: "business", output: nested }
    ] }))).hasProviderOwnedState).toBe(false);
  });

  it.each(["cross_domain", "error_400"] as const)("preserves caller-owned schemas and data during %s cleanup", (strategy) => {
    const schema = {
      type: "object",
      properties: {
        internal_id: { type: "string", enum: ["internal_value"] },
        _passthrough: { type: "object", default: { internal_value: "keep" } }
      },
      required: ["internal_id", "_passthrough"],
      additionalProperties: false
    };
    const body = {
      tools: [{ type: "function", name: "lookup", parameters: schema }],
      text: { format: { type: "json_schema", name: "result", schema } },
      metadata: { internal_id: "caller-owned", _passthrough: "caller-owned" },
      internal_trace: "provider-owned",
      input: [{
        type: "message", role: "user", _passthrough: "provider-owned",
        content: [{ type: "input_text", text: "continue", internal_note: "provider-owned" }]
      }]
    };
    const canonical = Buffer.from(JSON.stringify(body));
    const result = compileProviderStateAttempt(canonical, {
      strategy, priorStrategy: "cross_domain", errorCode: "invalid_encrypted_content"
    });
    const parsed = parseBody(result.body);
    expect(parsed.tools).toEqual(body.tools);
    expect(parsed.text).toEqual(body.text);
    expect(parsed.metadata).toEqual(body.metadata);
    expect(parsed).not.toHaveProperty("internal_trace");
    expect(parsed.input).toEqual([{
      type: "message", role: "user", content: [{ type: "input_text", text: "continue" }]
    }]);
    expect(result.metrics.privateMetadataFieldsRemoved).toBe(3);
    expect(parseBody(canonical)).toEqual(body);
  });

  it("recognizes the GPT reasoning transport envelope without claiming decryptability", () => {
    expect(validEncryptedContent()).toMatch(/^gAAAA/);
    expect(isValidGptReasoningEncryptedContent(validEncryptedContent())).toBe(true);
    expect(isValidGptReasoningEncryptedContent("gAAAA_invalid!")) .toBe(false);
    expect(isValidGptReasoningEncryptedContent(null)).toBe(false);
  });

  it("applies CPA shape cleanup while preserving valid-looking encrypted reasoning", () => {
    const valid = validEncryptedContent();
    const canonicalBody = Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      store: false,
      input: [
        { type: "reasoning", id: "rs_valid", encrypted_content: valid, summary: [] },
        { type: "reasoning", id: "rs_null", encrypted_content: null, summary: [] },
        { type: "reasoning", id: "rs_bad", encrypted_content: "bad", summary: [] },
        { type: "message", role: "user", content: "continue" }
      ]
    }));

    const result = compileProviderStateAttempt(canonicalBody, { strategy: "cpa" });
    const parsed = parseBody(result.body);

    expect(parsed.input).toEqual([
      { type: "reasoning", id: "rs_valid", encrypted_content: valid, summary: [] },
      { type: "reasoning", summary: [] },
      { type: "reasoning", summary: [] },
      { type: "message", role: "user", content: "continue" }
    ]);
    expect(result.metrics).toMatchObject({
      encryptedReasoningFieldsRemoved: 2,
      providerItemIdsRemoved: 2
    });
  });

  it("returns the original Buffer when CPA finds nothing to clean", () => {
    const canonicalBody = Buffer.from(JSON.stringify({
      store: true,
      input: [{ type: "reasoning", id: "rs_valid", encrypted_content: validEncryptedContent() }]
    }));

    const result = compileProviderStateAttempt(canonicalBody, { strategy: "cpa" });

    expect(result.body).toBe(canonicalBody);
    expect(result.bodyHash).toBe(hashProviderStateBody(canonicalBody));
  });

  it("builds a strict cross-domain body without breaking tool pairs", () => {
    const readableSummary = "The previous upstream summarized the completed work in readable text.";
    const canonicalBody = Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      prompt_cache_key: "session-old",
      internal_trace: "private",
      input: [
        {
          type: "reasoning",
          id: "rs_old",
          encrypted_content: validEncryptedContent(),
          summary: [{ type: "summary_text", text: "private summary" }]
        },
        { type: "compaction", id: "cmp_readable", encrypted_content: readableSummary },
        { type: "function_call", id: "fc_provider", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", id: "out_provider", call_id: "call_1", output: "ok" },
        { type: "function_call_output", call_id: "orphan", output: "drop me" },
        {
          type: "message",
          id: "msg_provider",
          role: "user",
          content: [{ type: "input_text", text: "continue", internal_note: "private" }],
          _passthrough: { provider: "old" }
        }
      ]
    }));

    const result = compileProviderStateAttempt(canonicalBody, {
      strategy: "cross_domain",
      targetStateDomain: "https://welfare.0xpsyche.me"
    });
    const parsed = parseBody(result.body);
    const input = parsed.input as Array<Record<string, unknown>>;

    expect(parsed).not.toHaveProperty("previous_response_id");
    expect(parsed).not.toHaveProperty("internal_trace");
    expect(parsed.prompt_cache_key).toMatch(/^cg:/);
    expect(input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: readableSummary }]
      },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }]
      }
    ]);
    expect(result.metrics).toMatchObject({
      reasoningItemsRemoved: 1,
      compactionItemsReplaced: 1,
      compactionItemsRemoved: 0,
      previousResponseIdsRemoved: 0,
      providerItemIdsRemoved: 3,
      privateMetadataFieldsRemoved: 3,
      orphanToolItemsRemoved: 1
    });
    expect(result.fidelity).toBe("degraded");
  });

  it.each([
    { type: "compaction", encrypted_content: "opaque-state" },
    { type: "item_reference", id: "item_remote" },
    { id: "item_remote" }
  ])("never discards unrecoverable cross-domain state: %j", item => {
    const body = Buffer.from(JSON.stringify({ input: [item] }));
    expect(() => compileProviderStateAttempt(body, { strategy: "cross_domain" })).toThrow("no complete recovery checkpoint");
    expect(parseBody(body).input).toEqual([item]);
  });

  it("requires continuation history even when cross-domain cleanup is inherited by an error repair", () => {
    const body = Buffer.from(JSON.stringify({ previous_response_id: "resp_foreign", input: "continue" }));
    expect(() => compileProviderStateAttempt(body, { strategy: "error_400", priorStrategy: "cross_domain", errorCode: "invalid_encrypted_content" }))
      .toThrow("no complete recovery checkpoint");
    expect(parseBody(body).previous_response_id).toBe("resp_foreign");
  });

  it("derives invalid_encrypted_content recovery from canonical input", () => {
    const canonicalBody = Buffer.from(JSON.stringify({
      store: false,
      input: [{
        type: "reasoning",
        id: "rs_foreign",
        encrypted_content: validEncryptedContent(),
        content: null,
        summary: [{ type: "summary_text", text: "keep this summary" }]
      }]
    }));

    const cpa = compileProviderStateAttempt(canonicalBody, { strategy: "cpa" });
    const recovery = compileProviderStateAttempt(canonicalBody, {
      strategy: "error_400",
      priorStrategy: "cpa",
      errorCode: "invalid_encrypted_content"
    });

    expect(parseBody(cpa.body).input).toEqual([{
      type: "reasoning",
      id: "rs_foreign",
      encrypted_content: validEncryptedContent(),
      content: null,
      summary: [{ type: "summary_text", text: "keep this summary" }]
    }]);
    expect(parseBody(recovery.body).input).toEqual([{
      type: "reasoning",
      summary: [{ type: "summary_text", text: "keep this summary" }]
    }]);
    expect(recovery.bodyHash).not.toBe(cpa.bodyHash);
  });

  it("restores only readable compaction for invalid_responses_request", () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_same_provider",
      encrypted_content: validEncryptedContent(),
      summary: []
    };
    const message = { type: "message", role: "user", content: "continue" };
    const canonicalBody = Buffer.from(JSON.stringify({
      previous_response_id: "resp_same_provider",
      input: [
        reasoning,
        { type: "compaction", id: "cmp_rejected", encrypted_content: "The previous work is preserved in this readable summary." },
        message
      ]
    }));

    const recovery = compileProviderStateAttempt(canonicalBody, {
      strategy: "error_400",
      priorStrategy: "original",
      errorCode: "invalid_responses_request"
    });

    expect(parseBody(recovery.body)).toEqual({
      previous_response_id: "resp_same_provider",
      input: [reasoning, { type: "message", role: "assistant", content: [{ type: "output_text", text: "The previous work is preserved in this readable summary." }] }, message]
    });
    expect(recovery.metrics.compactionItemsRemoved).toBe(0);
    expect(recovery.metrics.compactionItemsReplaced).toBe(1);
    expect(recovery.fidelity).toBe("summary");
    expect(providerStateErrorCode(400, Buffer.from(JSON.stringify({
      error: { code: "invalid_responses_request", type: "new_api_error" }
    })))).toBe("invalid_responses_request");
    expect(providerStateErrorCode(400, Buffer.from(JSON.stringify({
      type: "invalid_responses_request"
    })))).toBeNull();
  });

  it.each(["invalid_responses_request", "previous_response_not_found"] as const)(
    "preserves canonical context when %s has no recovery material", (errorCode) => {
      const reasoning = { type: "reasoning", id: "rs_keep", encrypted_content: null, summary: [] };
      const compaction = { type: "compaction", encrypted_content: "opaque-state" };
      const canonical = { store: false, previous_response_id: "resp_old", input: [reasoning, compaction] };
      const body = Buffer.from(JSON.stringify(canonical));
      expect(() => compileProviderStateAttempt(body, {
        strategy: "error_400", priorStrategy: "original", errorCode
      })).toThrow("no complete recovery checkpoint or readable summary");
      expect(parseBody(body)).toEqual(canonical);
    }
  );

  it.each(["cpa", "cross_domain"] as const)("retains prior %s cleanup during compaction recovery", (priorStrategy) => {
    const summary = { type: "message", role: "assistant", content: [{ type: "output_text", text: "All previous work is recorded in this summary." }] };
    const body = Buffer.from(JSON.stringify({
      store: false,
      input: [
        { type: "reasoning", id: "rs_old", encrypted_content: null, summary: [] },
        { type: "compaction", encrypted_content: "All previous work is recorded in this summary." }
      ]
    }));
    const recovery = compileProviderStateAttempt(body, {
      strategy: "error_400", priorStrategy, errorCode: "invalid_responses_request"
    });
    expect(parseBody(recovery.body).input).toEqual(priorStrategy === "cpa"
      ? [{ type: "reasoning", summary: [] }, summary]
      : [summary]);
    expect(recovery.metrics.compactionItemsReplaced).toBe(1);
    expect(recovery.metrics.compactionItemsRemoved).toBe(0);
    expect(recovery.fidelity).toBe("degraded");
  });

  it("replaces an invalid continuation only with its complete saved history", () => {
    const canonicalBody = Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      previous_response_id: "resp_old_provider",
      input: "continue"
    }));

    const recovery = compileProviderStateAttempt(canonicalBody, {
      strategy: "error_400",
      priorStrategy: "original",
      errorCode: "previous_response_not_found",
      recoverCompaction: () => ({ body: Buffer.from(JSON.stringify({ model: "gpt-5.5", input: [
        { role: "assistant", content: "Earlier complete answer." }, { role: "user", content: "continue" }
      ] })), fidelity: "exact" })
    });

    expect(parseBody(recovery.body)).toEqual({
      model: "gpt-5.5",
      input: [{ role: "assistant", content: "Earlier complete answer." }, { role: "user", content: "continue" }]
    });
    expect(recovery.metrics.previousResponseIdsRemoved).toBe(1);
  });

  it("reports provider-owned state without retaining its values", () => {
    const analysis = analyzeProviderState(Buffer.from(JSON.stringify({
      previous_response_id: "resp_secret",
      prompt_cache_key: "cache_secret",
      input: [
        { type: "reasoning", encrypted_content: validEncryptedContent() },
        { type: "reasoning", encrypted_content: null },
        { type: "compaction", encrypted_content: "opaque" }
      ]
    })));

    expect(analysis).toEqual({
      reasoningItemCount: 2,
      encryptedReasoningItemCount: 2,
      invalidEncryptedReasoningItemCount: 1,
      encryptedAgentMessageCount: 0,
      encryptedNonCompactionItemCount: 2,
      compactionItemCount: 1,
      previousResponseIdPresent: true,
      hasProviderOwnedState: true
    });
    expect(JSON.stringify(analysis)).not.toContain("secret");
  });

  welfareFixtureIt("compiles the welfare failure capture offline without breaking tool pairs", () => {
    const capture = JSON.parse(readFileSync(WELFARE_CAPTURE_PATH, "utf8")) as {
      incoming_request: {
        body: { text: string; truncated: boolean };
      };
    };
    expect(capture.incoming_request.body.truncated).toBe(false);
    const canonicalBody = Buffer.from(capture.incoming_request.body.text);
    const analysis = analyzeProviderState(canonicalBody);
    const result = compileProviderStateAttempt(canonicalBody, {
      strategy: "cross_domain",
      targetStateDomain: "welfare-fixture-target"
    });
    const compiled = parseBody(result.body);
    const input = compiled.input as Array<Record<string, unknown>>;
    const calls = input.filter((item) =>
      item.type === "function_call" || item.type === "custom_tool_call"
    );
    const outputs = input.filter((item) =>
      item.type === "function_call_output" || item.type === "custom_tool_call_output"
    );
    const callIds = new Set(calls.map((item) => item.call_id));
    const outputCallIds = new Set(outputs.map((item) => item.call_id));

    expect(analysis).toMatchObject({
      reasoningItemCount: 59,
      encryptedReasoningItemCount: 59,
      invalidEncryptedReasoningItemCount: 15,
      compactionItemCount: 1,
      previousResponseIdPresent: false
    });
    expect(result.metrics).toMatchObject({
      reasoningItemsRemoved: 59,
      compactionItemsReplaced: 1,
      compactionItemsRemoved: 0
    });
    expect(input).toHaveLength(156);
    expect(input.filter((item) => item.type === "reasoning")).toHaveLength(0);
    expect(input.filter((item) => item.type === "compaction")).toHaveLength(0);
    expect(input.filter((item) => item.type === "message")).toHaveLength(53);
    expect(calls).toHaveLength(51);
    expect(outputs).toHaveLength(51);
    expect(callIds).toEqual(outputCallIds);
  });
});
