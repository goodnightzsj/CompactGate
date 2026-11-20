import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { buildPrimaryOpenAiProxyPlan } from "../src/server/openai-proxy-plan.js";
import { anthropicRequestToResponses, responsesRequestToAnthropic, responsesRequestToChat } from "../src/server/protocol-conversion.js";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function plan(body: unknown, protocol: "anthropic_messages" | "openai_chat" = "anthropic_messages") {
  const config = structuredClone(DEFAULT_CONFIG);
  config.primary.upstream_protocol = protocol;
  config.primary.base_url = "http://127.0.0.1:1/v1";
  config.primary_failover.auto_schedule = false;
  return JSON.parse(buildPrimaryOpenAiProxyPlan({ config, url: new URL("http://compactgate.local/v1/responses"),
    headers: {}, rawBody: bytes(body), endpoint: "/responses", method: "POST",
    compactionBridge: new CompactionBridgeStore(), primaryFailover: new PrimaryFailoverState(), reservePrimarySelection: false
  }).upstreamBody.toString());
}

describe("Responses request fidelity in translated plans", () => {
  it("keeps the structured output schema in the Anthropic plan", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
    const translated = plan({ model: "fixture", input: "answer", text: { verbosity: "low", format: { type: "json_schema", name: "answer", strict: true, schema } } });
    expect(translated.output_config).toEqual({ format: { type: "json_schema", schema } });
    expect(plan({ model: "fixture", input: "answer", text: { format: { type: "text" } } })).not.toHaveProperty("output_config");
  });

  it.each([{ format: { type: "json_object" } }, { format: { type: "json_schema" } }, { format: null }, { unknown: true }, null])("rejects unrepresentable structured formats: %j", text => {
    expect(() => plan({ model: "fixture", input: "answer", text })).toThrow(/Responses text/);
  });

  it.each(["function_call_output", "custom_tool_call_output"])("preserves text, image and document tool blocks in %s", type => {
    const output = [
      { type: "input_text", text: "screenshot follows" },
      { type: "input_image", image_url: "data:image/png;base64,ZmFrZQ==" },
      { type: "input_file", file_url: "https://example.test/fixture.pdf" },
      { type: "input_text", text: "end" }
    ];
    const translated = plan({ model: "fixture", input: [{ type, call_id: "tool-1", output }] });
    expect(translated.messages[0].content[0]).toEqual({ type: "tool_result", tool_use_id: "tool-1", content: [
      { type: "text", text: "screenshot follows" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
      { type: "document", source: { type: "url", url: "https://example.test/fixture.pdf" } },
      { type: "text", text: "end" }
    ] });
    const replay = anthropicRequestToResponses(bytes({ model: "fixture", max_tokens: 100, messages: translated.messages }));
    expect(JSON.parse(responsesRequestToAnthropic(replay).toString()).messages).toEqual(translated.messages);
  });

  for (const protocol of ["anthropic_messages", "openai_chat"] as const) {
    const convert = protocol === "anthropic_messages" ? responsesRequestToAnthropic : responsesRequestToChat;
    it.each(["user", "assistant", "system", "developer"])(`${protocol} accepts omitted message type for %s`, role => {
      const message = { role, content: "fixture message" };
      expect(plan({ model: "fixture", input: [message] }, protocol)).toEqual(plan({ model: "fixture", input: [{ ...message, type: "message" }] }, protocol));
    });
    it.each([
      { type: "unknown", role: "user", content: "hello" },
      { type: null, role: "user", content: "hello" },
      { role: "tool", content: "hello" }, { role: "user" }, { role: "user", content: 123 },
      { role: "user", content: [null] }
    ])(`${protocol} rejects invalid messages: %j`, item => {
      expect(() => convert(bytes({ model: "fixture", input: [item] }))).toThrow();
    });
  }
});
