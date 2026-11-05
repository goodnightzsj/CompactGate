import { describe, expect, it } from "vitest";
import { analyzeProviderState, compileProviderStateAttempt, recoverCompactionItemIds } from "../src/server/provider-state-portability.js";
import { classifyProviderStateFailure } from "../src/server/provider-state-errors.js";
import { runProviderStateMigration } from "../src/server/provider-state-migration.js";
import { recoveryPlanKey } from "../src/server/provider-state-checkpoints.js";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const error = { error: { code: "invalid_encrypted_content", type: "invalid_request_error" } };
const failure = classifyProviderStateFailure(400, encode(error))!;
const user = { role: "user", content: "continue" };
const compaction = { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-compaction" };
const carriers = [
  { type: "web_search_call", id: "ws_fixture", action: { type: "search", query: "weather" }, status: "completed" },
  { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "visible" }] },
  { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read", arguments: '{"encrypted_content":"business"}' },
  { type: "custom_tool_call", call_id: "call_custom", name: "shell", input: "echo fixture" },
  { type: "function_call_output", call_id: "call_fixture", output: { encrypted_content: "business" } }
];

describe("provider-owned encrypted replay carriers", () => {
  it.each(carriers)("cleans only the sealed copy of $type after rejection", item => {
    const body = { store: false, input: [{ ...item, encrypted_content: "sealed-fixture" }, user] };
    const canonical = encode(body);
    expect(analyzeProviderState(canonical).hasProviderOwnedState).toBe(true);
    expect(compileProviderStateAttempt(canonical, { strategy: "original" }).body).toBe(canonical);
    const compiled = compileProviderStateAttempt(canonical, { strategy: "error_400", errorCode: "invalid_encrypted_content", failure });
    expect(JSON.parse(compiled.body.toString())).toEqual({ ...body, input: [item, user] });
    expect(compiled.fidelity).toBe("degraded");
    expect(canonical).toEqual(encode(body));
  });

  it.each(carriers)("invalidates a successful repair hint when $type state changes", item => {
    const key = (state: string) => recoveryPlanKey("synthetic", encode({ input: [{ ...item, encrypted_content: state }, user] }));
    expect(key("first")).not.toBe(key("second"));
  });

  it("locates a rejected nested agent seal by its full ciphertext without touching another seal", () => {
    const text = { type: "input_text", text: "readable result" };
    const keep = { type: "encrypted_content", encrypted_content: "keep-seal" };
    const agent = { type: "agent_message", content: [text, keep, { type: "encrypted_content", encrypted_content: "bad-seal" }] };
    const targeted = classifyProviderStateFailure(400, encode({ error: { type: "invalid_request_error",
      message: "The encrypted content bad-seal could not be verified." } }))!;
    const result = compileProviderStateAttempt(encode({ input: [agent, compaction, user] }), {
      strategy: "error_400", errorCode: "invalid_encrypted_content", failure: targeted
    });
    expect(JSON.parse(result.body.toString()).input).toEqual([{ ...agent, content: [text, keep] }, compaction, user]);
  });

  it("does not infer compaction until every other encrypted carrier has been handled", () => {
    const web = { ...carriers[0], encrypted_content: "sealed-web" };
    const canonical = encode({ store: false, input: [compaction, web, user] });
    expect(recoverCompactionItemIds(canonical, failure)).toBeNull();
    const result = compileProviderStateAttempt(canonical, { strategy: "error_400", errorCode: "invalid_encrypted_content", failure, allowCompactionDrop: true });
    expect(JSON.parse(result.body.toString()).input).toEqual([compaction, carriers[0], user]);
    expect(result.metrics.compactionItemsRemoved).toBe(0);
  });

  it.each([
    { type: "future_sealed_state", encrypted_content: "opaque" },
    { type: "message", role: "assistant", content: [], encrypted_content: "opaque" },
    { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "opaque" }] }
  ])("retains opaque $type and never sacrifices compaction to it", item => {
    const canonical = encode({ store: false, input: [compaction, item, user] });
    expect(recoverCompactionItemIds(canonical, failure)).toBeNull();
    expect(compileProviderStateAttempt(canonical, { strategy: "error_400", errorCode: "invalid_encrypted_content", failure, allowCompactionDrop: true }).body).toBe(canonical);
  });

  it("keeps readable reasoning but drops a rejected empty shell", () => {
    const readable = { type: "reasoning", summary: [{ type: "summary_text", text: "visible summary" }] };
    const canonical = encode({ input: [{ type: "reasoning", id: "rs_empty", encrypted_content: "opaque", summary: [] },
      { ...readable, id: "rs_readable", encrypted_content: "opaque-readable" }, user] });
    const result = compileProviderStateAttempt(canonical, { strategy: "error_400", errorCode: "invalid_encrypted_content", failure });
    expect(JSON.parse(result.body.toString()).input).toEqual([readable, user]);
  });

  it("preserves an earlier targeted repair when a later item is rejected", async () => {
    const canonical = encode({ store: false, input: [{ ...carriers[0], encrypted_content: "web" },
      { ...carriers[1], encrypted_content: "message" }, user] });
    const sent: unknown[] = [];
    const recovered = await runProviderStateMigration({ canonicalBody: canonical, targetStateDomain: "synthetic", canReplay: () => true,
      startGenericRecovery: () => null, send: async body => {
        const request = JSON.parse(body.toString()); sent.push(request.input);
        const index = request.input.findIndex((item: { encrypted_content?: string }) => item.encrypted_content);
        return { status: index === -1 ? 200 : 400, responseBody: encode(index === -1 ? { output: [] } : { error: { ...error.error, param: `input[${index}].encrypted_content` } }),
          responseHeaders: {}, responseBodyTruncated: false, firstTokenMs: null, streamSummary: null, errorSummary: null, clientDisconnectPhase: "none" } satisfies BufferedUpstreamResult;
      } });
    expect(recovered.result.status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)).toEqual([carriers[0], carriers[1], user]);
  });
});
