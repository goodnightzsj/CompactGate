import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";
import { buildPrimaryOpenAiProxyPlan } from "../src/server/openai-proxy-plan.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import {
  ProtocolConversionError,
  responsesCompactRequestToAnthropic,
  responsesRequestToAnthropic,
  responsesRequestToChat
} from "../src/server/protocol-conversion.js";
import { analyzeProviderState } from "../src/server/provider-state-portability.js";

const noContinuation = [{}, { previous_response_id: null }, { previousResponseId: null }, {
  previous_response_id: null, previousResponseId: null
}];
const continuation = [{ previous_response_id: "resp_foreign" }, { previousResponseId: "resp_foreign" }, {
  previous_response_id: null, previousResponseId: "resp_foreign"
}];
const converters = [
  responsesRequestToAnthropic, responsesCompactRequestToAnthropic, responsesRequestToChat
];
function request(fields: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ model: "synthetic-model", input: "Full input context", ...fields }));
}

describe("nullable Responses continuation", () => {
  it.each(noContinuation)("translates self-contained requests: %j", fields => {
    for (const convert of converters) {
      const translated = JSON.parse(convert(request(fields)).toString());
      expect(translated.messages).toEqual(JSON.parse(convert(request({})).toString()).messages);
      expect(translated).not.toHaveProperty("previous_response_id");
      expect(translated).not.toHaveProperty("previousResponseId");
    }
    expect(analyzeProviderState(request(fields))).toMatchObject({
      previousResponseIdPresent: false, hasProviderOwnedState: false
    });
  });

  it.each(continuation)("still rejects unavailable provider history: %j", fields => {
    for (const convert of converters) {
      expect(() => convert(request(fields))).toThrow(ProtocolConversionError);
      try { convert(request(fields)); } catch (error) {
        expect((error as ProtocolConversionError).status).toBe(422);
      }
    }
    expect(analyzeProviderState(request(fields))).toMatchObject({
      previousResponseIdPresent: true, hasProviderOwnedState: true
    });
  });

  it.each(["anthropic_messages", "openai_chat"] as const)(
    "accepts null through the complete %s primary plan", upstreamProtocol => {
      const config = structuredClone(DEFAULT_CONFIG);
      config.primary.upstream_protocol = upstreamProtocol;
      config.primary.api_key = "";
      config.primary.api_key_env = "";
      for (const fields of noContinuation) {
        const plan = buildPrimaryOpenAiProxyPlan({
          config, url: new URL("http://127.0.0.1/v1/responses"), headers: {},
          rawBody: request(fields), endpoint: "/responses",
          compactionBridge: new CompactionBridgeStore(), primaryFailover: new PrimaryFailoverState(),
          reservePrimarySelection: false
        });
        expect(JSON.parse(plan.upstreamBody.toString()).messages).toHaveLength(1);
      }
    }
  );
});
