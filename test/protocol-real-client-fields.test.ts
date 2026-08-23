import { describe, expect, it } from "vitest";
import {
  anthropicRequestToChat,
  anthropicRequestToResponses,
  responsesRequestToAnthropic,
  responsesRequestToChat
} from "../src/server/protocol-conversion.js";

/**
 * Field shapes taken from real captured traffic rather than invented: every
 * assertion here failed before, on 100% of live requests, while the existing
 * suite passed because its fixtures omitted the fields real clients always send.
 */

/** Claude Code's every-turn shape: 419/469 captures carry context_management. */
function claudeCodeBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    model: "claude-opus-4-8",
    max_tokens: 32_000,
    system: [{ type: "text", text: "You are Claude Code." }],
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    ...overrides
  }));
}

/** Codex's every-turn shape: all 187 non-truncated captures match it exactly. */
function codexBody(): Buffer {
  return Buffer.from(JSON.stringify({
    model: "gpt-5.6-sol",
    reasoning: { context: "prior", effort: "high" },
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    input: [
      { type: "additional_tools", role: "developer", tools: [
        { type: "function", name: "exec", parameters: { type: "object", properties: {} } }
      ] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      { type: "custom_tool_call", status: "completed", call_id: "call_1", name: "exec", input: "ls -la" },
      { type: "custom_tool_call_output", call_id: "call_1", output: "total 0" }
    ]
  }));
}

describe("cross-protocol requests survive the fields real clients always send", () => {
  it("translates Claude Code's thinking effort and drops its context directive", () => {
    const body = JSON.parse(anthropicRequestToResponses(claudeCodeBody()).toString("utf8"));

    // Refusing output_config / context_management 422'd every Claude Code turn
    // before the upstream was contacted.
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body).not.toHaveProperty("context_management");
    expect(body).not.toHaveProperty("output_config");
  });

  it("keeps the effort tier the adaptive dialect carries instead of assuming high", () => {
    for (const [effort, expected] of [["low", "low"], ["medium", "medium"], ["max", "xhigh"]]) {
      const body = JSON.parse(
        anthropicRequestToResponses(claudeCodeBody({ output_config: { effort } })).toString("utf8")
      );
      expect(body.reasoning.effort).toBe(expected);
    }
  });

  it("carries a structured-output schema across rather than dropping it", () => {
    const schema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false
    };
    // 23/469 captures use this to get a parseable answer. Dropping the constraint
    // would hand the caller prose where it is about to JSON.parse.
    const responses = JSON.parse(anthropicRequestToResponses(claudeCodeBody({
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema } }
    })).toString("utf8"));
    expect(responses.text.format).toMatchObject({ type: "json_schema", schema, strict: true });

    const chat = JSON.parse(anthropicRequestToChat(claudeCodeBody({
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema } }
    })).toString("utf8"));
    expect(chat.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema, strict: true }
    });
  });

  it("stays fail-loud on an output_config key whose meaning is unknown", () => {
    expect(() => anthropicRequestToResponses(claudeCodeBody({
      output_config: { effort: "max", future_constraint: { on: true } }
    }))).toThrow(/output_config\.future_constraint/);
  });

  it("lifts Codex's inline tool declarations into the request's tool list", () => {
    for (const [label, converted] of [
      ["chat", responsesRequestToChat(codexBody())],
      ["anthropic", responsesRequestToAnthropic(codexBody())]
    ] as const) {
      const body = JSON.parse(converted.toString("utf8"));
      // Dropping the additional_tools item would leave the upstream unaware of a
      // tool the very next custom_tool_call goes on to call.
      const names = (body.tools as Array<Record<string, unknown>>).map((tool) =>
        label === "chat" ? (tool.function as Record<string, unknown>).name : tool.name);
      expect(names, label).toContain("exec");
    }
  });

  it("translates a custom tool call and its output on both cross-protocol routes", () => {
    const chat = JSON.parse(responsesRequestToChat(codexBody()).toString("utf8"));
    expect(chat.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "ls -la" } }]
      }),
      { role: "tool", tool_call_id: "call_1", content: "total 0" }
    ]));
    // Codex's reasoning siblings, include, and text.verbosity have no Chat
    // counterpart and are dropped; the effort is what actually carries over.
    expect(chat.reasoning_effort).toBe("high");
    expect(chat).not.toHaveProperty("include");
    expect(chat).not.toHaveProperty("text");

    const anthropic = JSON.parse(responsesRequestToAnthropic(codexBody()).toString("utf8"));
    const blocks = (anthropic.messages as Array<Record<string, unknown>>)
      .flatMap((message) => message.content as Array<Record<string, unknown>>);
    // Anthropic's tool_use.input is always an object, so freeform text is carried
    // under a key rather than parsed as the JSON it is not.
    expect(blocks).toEqual(expect.arrayContaining([
      { type: "tool_use", id: "call_1", name: "exec", input: { input: "ls -la" } },
      { type: "tool_result", tool_use_id: "call_1", content: "total 0" }
    ]));
  });
});
