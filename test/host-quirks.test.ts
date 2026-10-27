import { describe, expect, it } from "vitest";
import {
  applyHostBodyQuirks,
  applyHostQuirks,
  recoverAgentrouterCompactionIds,
  resolveHostShortCircuit
} from "../src/server/host-quirks.js";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";
import { buildPrimaryOpenAiProxyPlan } from "../src/server/openai-proxy-plan.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";

describe("applyHostQuirks", () => {
  it("adds the 1m context beta for opus targets on anyrouter", () => {
    const headers: Record<string, string> = {};
    const applied = applyHostQuirks({
      host: "anyrouter.top",
      sourceModel: "claude-haiku-4-5-20251001",
      targetModel: "claude-opus-5",
      headers
    });
    expect(applied).toEqual(["anyrouter-context-1m"]);
    expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
  });

  it("keeps existing beta tokens and stays idempotent", () => {
    const headers: Record<string, string> = { "anthropic-beta": "compact-2026-01-12,context-1m-2025-08-07" };
    applyHostQuirks({ host: "api.anyrouter.top", sourceModel: null, targetModel: "claude-opus-5", headers });
    expect(headers["anthropic-beta"]).toBe("compact-2026-01-12,context-1m-2025-08-07");
  });

  it("leaves other hosts untouched", () => {
    const other: Record<string, string> = {};
    applyHostQuirks({ host: "agentrouter.org", sourceModel: null, targetModel: "claude-opus-5", headers: other });
    expect(other["anthropic-beta"]).toBeUndefined();
  });

  it("adds the beta for non-opus targets too", () => {
    const headers: Record<string, string> = {};
    applyHostQuirks({ host: "anyrouter.top", sourceModel: null, targetModel: "claude-sonnet-4-5", headers });
    expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
  });

  it("drops the codex responses-lite hint on muyuan", () => {
    const headers: Record<string, string> = {
      "x-openai-internal-codex-responses-lite": "true",
      "authorization": "Bearer k"
    };
    const applied = applyHostQuirks({
      host: "muyuan.do",
      sourceModel: "gpt-5.6-sol",
      targetModel: "gpt-5.5",
      headers
    });
    expect(applied).toEqual(["muyuan-drop-codex-responses-lite"]);
    expect(headers).toEqual({ authorization: "Bearer k" });
  });

  it("keeps the responses-lite hint on other hosts", () => {
    const headers: Record<string, string> = { "x-openai-internal-codex-responses-lite": "true" };
    applyHostQuirks({ host: "anyrouter.top", sourceModel: null, targetModel: "gpt-5.6-sol", headers });
    expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  it("does not match a lookalike host suffix", () => {
    const headers: Record<string, string> = {};
    applyHostQuirks({ host: "notanyrouter.top", sourceModel: null, targetModel: "claude-opus-5", headers });
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});

describe("applyHostBodyQuirks", () => {
  // Shaped after the capture that motivated this: a Codex turn replaying the
  // previous response's items, two of which carry ids minted by whichever Azure
  // resource served that turn.
  const agentrouterBody = () => Buffer.from(JSON.stringify({
    model: "gpt-6-astra",
    store: false,
    input: [
      { type: "message", role: "assistant", id: "msg_02e22a5d85dec6d5006aa7a6be80d88196a258a8f45cfab653", content: [] },
      {
        type: "custom_tool_call",
        id: "ctc_02e22a5d85dec6d5006aa7a6bf80508196bc3142355a7ab3b8",
        call_id: "call_z22vOmEl9pMDJnfq56ZQ2h1E",
        name: "exec",
        input: "1"
      },
      {
        type: "reasoning",
        id: "rs_02e22a5d85dec6d5006aa7a89906d48196841ad44485bdbca6",
        summary: [],
        encrypted_content: "gAAAAAB"
      }
    ]
  }));

  it("strips replay metadata ids for stateless agentrouter responses requests", () => {
    const context = {
      host: "agentrouter.org",
      upstreamProtocol: "openai_responses" as const,
      body: agentrouterBody()
    };
    expect(applyHostBodyQuirks(context)).toEqual(["agentrouter-strip-input-item-ids"]);

    const items = JSON.parse(context.body.toString()).input;
    expect(items.every((item: Record<string, unknown>) => !("id" in item))).toBe(true);
  });

  it("keeps the state that is not the item id", () => {
    const context = {
      host: "agentrouter.org",
      upstreamProtocol: "openai_responses" as const,
      body: agentrouterBody()
    };
    applyHostBodyQuirks(context);
    const items = JSON.parse(context.body.toString()).input;

    // Reasoning state rides on the encrypted payload, tool pairing on call_id.
    expect(items[1].call_id).toBe("call_z22vOmEl9pMDJnfq56ZQ2h1E");
    expect(items[2].encrypted_content).toBe("gAAAAAB");
    expect(items[2].summary).toEqual([]);
    expect(items).toHaveLength(3);
  });

  it.each([true, undefined])("preserves stored history when store is %s", (store) => {
    const body = Buffer.from(JSON.stringify({ ...JSON.parse(agentrouterBody().toString()), store }));
    const context = { host: "agentrouter.org", upstreamProtocol: "openai_responses" as const, body };
    expect(applyHostBodyQuirks(context)).toEqual([]);
    expect(context.body).toBe(body);
  });

  it.each(["item_reference", undefined])("preserves references and their targets when type is %s", (type) => {
    const parsed = JSON.parse(agentrouterBody().toString());
    parsed.input.push({ type, id: parsed.input[0].id });
    const body = Buffer.from(JSON.stringify(parsed));
    const context = { host: "agentrouter.org", upstreamProtocol: "openai_responses" as const, body };
    expect(applyHostBodyQuirks(context)).toEqual([]);
    expect(context.body).toBe(body);
  });

  it("keeps local-shell and MCP approval linkage through the real proxy plan", () => {
    const input = [
      { type: "local_shell_call_output", id: "call_shell", output: "done" },
      { type: "mcp_approval_request", id: "approval_1", name: "read", arguments: "{}", server_label: "test" },
      { type: "mcp_approval_response", approval_request_id: "approval_1", approve: true },
      { type: "future_item", id: "opaque_1" }
    ];
    const config = structuredClone(DEFAULT_CONFIG);
    config.primary.base_url = "https://agentrouter.org/v1";
    const plan = buildPrimaryOpenAiProxyPlan({
      config, url: new URL("http://localhost/v1/responses"), headers: {},
      rawBody: Buffer.from(JSON.stringify({ model: "test", store: false, input })),
      endpoint: "/v1/responses", compactionBridge: new CompactionBridgeStore(),
      primaryFailover: new PrimaryFailoverState()
    });
    expect(JSON.parse(plan.upstreamBody.toString()).input).toEqual(input);
  });

  it("leaves the body untouched when there are no ids to strip", () => {
    const body = Buffer.from(JSON.stringify({
      model: "gpt-6-astra",
      input: [{ type: "message", role: "user", content: [] }]
    }));
    const context = { host: "agentrouter.org", upstreamProtocol: "openai_responses" as const, body };
    expect(applyHostBodyQuirks(context)).toEqual([]);
    expect(context.body).toBe(body);
  });

  it("does not apply to any other host", () => {
    for (const host of ["anyrouter.top", "opencode.9962510.xyz", "notagentrouter.org"]) {
      const context = { host, upstreamProtocol: "openai_responses" as const, body: agentrouterBody() };
      expect(applyHostBodyQuirks(context)).toEqual([]);
      expect(JSON.parse(context.body.toString()).input[0].id).toBeDefined();
    }
  });

  it("does not apply to a non-Responses protocol on the same host", () => {
    const context = {
      host: "agentrouter.org",
      upstreamProtocol: "anthropic_messages" as const,
      body: agentrouterBody()
    };
    expect(applyHostBodyQuirks(context)).toEqual([]);
    expect(JSON.parse(context.body.toString()).input[0].id).toBeDefined();
  });
});

describe("agentrouter Azure error envelopes", () => {
  const message = "The requested item was created under a different Azure OpenAI resource. " +
    "Use the same resource that created the item to access it.";
  const direct = { error: { code: 0, type: "invalid_request_error", message } };
  const wrap = (raw: string, suffix = "") => ({ error: {
    type: "invalid_request_error", code: null,
    message: "failed to decode error response: json: cannot unmarshal number into Go struct field " +
      `gateway.Error.code of type string, raw: ${raw}${suffix}`
  } });
  const body = Buffer.from(JSON.stringify({ store: false, input: [
    { type: "compaction", id: "cmp_synthetic", encrypted_content: "opaque-state" }
  ] }));
  const recover = (error: unknown) => recoverAgentrouterCompactionIds(
    "agentrouter.org", body, 400, Buffer.from(JSON.stringify(error))
  );

  it.each([0, "0", null, undefined])("recognizes direct errors independently of code=%s", (code) => {
    expect(recover({ error: { ...direct.error, code } })?.removedIds).toBe(1);
  });

  it.each([0, "0", null, undefined])("recognizes the Responses bad-request prefix independently of code=%s", (code) => {
    const repair = recover({ error: { type: "invalid_request_error", param: "", code,
      message: `OpenAI Responses bad request: ${message} [trace_id=6f7bf4f452d030a24110788b049c1a4b]`
    } });
    expect(repair?.removedIds).toBe(1);
    expect(JSON.parse(repair!.body.toString()).input).toEqual([
      { type: "compaction", encrypted_content: "opaque-state" }
    ]);
    expect(JSON.parse(body.toString()).input[0].id).toBe("cmp_synthetic");
  });

  it.each([
    ["bare JSON", wrap(JSON.stringify(direct))],
    ["trace suffix", wrap(JSON.stringify(direct), `\n[trace_id=${"a".repeat(32)}]`)],
    ["formatted JSON", wrap(JSON.stringify(direct, null, 2), ` \r\n[trace_id=${"B".repeat(32)}] \n`)],
    ["escaped message", wrap(JSON.stringify({ error: { ...direct.error, message: `${message} trace_id: synthetic; \"{raw:}\\\"` } }))],
    ["redacted field", wrap(JSON.stringify(direct)).error.message.replace("gateway.Error", "***.***")]
  ])("recognizes a single known Go wrapper: %s", (_name, fixture) => {
    const response = typeof fixture === "string" ? { error: { ...direct.error, message: fixture } } : fixture;
    const repair = recover(response);
    expect(repair?.removedIds).toBe(1);
    expect(JSON.parse(repair!.body.toString()).input).toEqual([
      { type: "compaction", encrypted_content: "opaque-state" }
    ]);
    expect(JSON.parse(body.toString()).input[0].id).toBe("cmp_synthetic");
  });

  it.each([
    ["quoted Azure message", { error: { ...direct.error, message: `Other error quoting: ${message}` } }],
    ["quoted Responses wrapper", { error: { ...direct.error, message: `Quoted: OpenAI Responses bad request: ${message}` } }],
    ["Responses wrapper quoting Azure", { error: { ...direct.error, message: `OpenAI Responses bad request: Quoted: ${message}` } }],
    ["other Responses error", { error: { ...direct.error, message: "OpenAI Responses bad request: Invalid model" } }],
    ["incomplete Azure message", { error: { ...direct.error, message: `OpenAI Responses bad request: ${message.slice(0, -1)}` } }],
    ["wrong Responses error type", { error: { type: "other_error", message: `OpenAI Responses bad request: ${message}` } }],
    ["nested Responses wrapper", { error: { ...direct.error, message: `OpenAI Responses bad request: OpenAI Responses bad request: ${message}` } }],
    ["unknown wrapper", { error: { ...direct.error, message: `proxy failure, raw: ${JSON.stringify(direct)}` } }],
    ["invalid JSON", wrap(JSON.stringify(direct).slice(0, -1))],
    ["HTML", wrap(`<html>${message}</html>`)],
    ["JSON string", wrap(JSON.stringify(JSON.stringify(direct)))],
    ["array", wrap(JSON.stringify([direct]))],
    ["null", wrap("null")],
    ["wrong inner type", wrap(JSON.stringify({ error: { ...direct.error, type: "other_error" } }))],
    ["missing inner type", wrap(JSON.stringify({ error: { message } }))],
    ["inner quotation", wrap(JSON.stringify({ error: { ...direct.error, message: `Quoted: ${message}` } }))],
    ["nested wrapper", wrap(JSON.stringify(wrap(JSON.stringify(direct))))],
    ["unknown suffix", wrap(JSON.stringify(direct), " extra text")],
    ["invalid trace", wrap(JSON.stringify(direct), "\n[trace_id=not-a-trace]")],
    ["second JSON object", wrap(`${JSON.stringify(direct)} {}`)],
    ["wrong outer type", { error: { ...wrap(JSON.stringify(direct)).error, type: "other_error" } }],
    ["other field", { error: { ...direct.error, message: wrap(JSON.stringify(direct)).error.message.replace(".code of", ".status of") } }],
    ["other decode failure", { error: { ...direct.error, message: wrap(JSON.stringify(direct)).error.message.replace("unmarshal number", "unmarshal bool") } }]
  ])("does not infer an Azure repair from %s", (_name, fixture) => {
    expect(recover(fixture)).toBeNull();
  });
});

describe("resolveHostShortCircuit", () => {
  const body = Buffer.from(JSON.stringify({
    model: "claude-opus-4-8",
    system: "a".repeat(400),
    messages: [{ role: "user", content: "b".repeat(400) }]
  }));

  it("answers count_tokens locally for agentrouter", () => {
    const result = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: body
    });
    expect(result?.id).toBe("local-count-tokens");
    // 800 non-CJK characters at 3.5 chars/token.
    expect(JSON.parse(result!.body.toString()).input_tokens).toBe(229);
  });

  it("counts CJK text denser than latin text", () => {
    const cjk = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "中".repeat(700) }] }))
    });
    // 700 CJK characters at 2 chars/token.
    expect(JSON.parse(cjk!.body.toString()).input_tokens).toBe(350);

    const latin = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "a".repeat(700) }] }))
    });
    expect(JSON.parse(latin!.body.toString()).input_tokens).toBe(200);
  });

  it("ignores base64 image payloads", () => {
    const result = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: Buffer.from(JSON.stringify({
        messages: [{
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(10000) } }]
        }]
      }))
    });
    expect(JSON.parse(result!.body.toString()).input_tokens).toBe(0);
  });

  it("leaves normal messages requests alone", () => {
    expect(resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages",
      rawBody: body
    })).toBeNull();
  });

  it("also answers count_tokens locally for anyrouter", () => {
    expect(resolveHostShortCircuit({
      host: "anyrouter.top",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: body
    })?.id).toBe("local-count-tokens");
  });

  it("leaves hosts that support the endpoint alone", () => {
    expect(resolveHostShortCircuit({
      host: "opencode.9962510.xyz",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: body
    })).toBeNull();
  });

  it("returns zero tokens for an unparsable body", () => {
    const result = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/messages/count_tokens",
      rawBody: Buffer.from("not json")
    });
    expect(JSON.parse(result!.body.toString())).toEqual({ input_tokens: 0 });
  });
});
