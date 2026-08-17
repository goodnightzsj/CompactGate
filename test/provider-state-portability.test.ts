import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
      previous_response_id: "resp_old_provider",
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
        { type: "compaction", id: "cmp_opaque", encrypted_content: "OPAQUE_STATE_0123456789" },
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
      compactionItemsRemoved: 1,
      previousResponseIdsRemoved: 1,
      providerItemIdsRemoved: 3,
      privateMetadataFieldsRemoved: 3,
      orphanToolItemsRemoved: 1
    });
    expect(result.fidelity).toBe("degraded");
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

  it("removes only compaction for invalid_responses_request", () => {
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
        { type: "compaction", id: "cmp_rejected", encrypted_content: "opaque-state" },
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
      input: [reasoning, message]
    });
    expect(recovery.metrics.compactionItemsRemoved).toBe(1);
    expect(recovery.fidelity).toBe("degraded");
    expect(providerStateErrorCode(400, Buffer.from(JSON.stringify({
      error: { code: "invalid_responses_request", type: "new_api_error" }
    })))).toBe("invalid_responses_request");
    expect(providerStateErrorCode(400, Buffer.from(JSON.stringify({
      type: "invalid_responses_request"
    })))).toBeNull();
  });

  it("removes an invalid previous_response_id when input is not an item array", () => {
    const canonicalBody = Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      previous_response_id: "resp_old_provider",
      input: "continue"
    }));

    const recovery = compileProviderStateAttempt(canonicalBody, {
      strategy: "error_400",
      priorStrategy: "original",
      errorCode: "previous_response_not_found"
    });

    expect(parseBody(recovery.body)).toEqual({
      model: "gpt-5.5",
      input: "continue"
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
